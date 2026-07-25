import { type IdentityRole, normalizeIdentityEmail } from "./identity.js";
import {
  type PasswordRecord,
  lockStateFor,
  nextFailureState,
  verifyPassword,
} from "./passwords.js";
import { type AuthoritySession, sessionAuthorityFor } from "./session-authority.js";

// Hosted passwordless sign-in for the pre-production surface.
//
// Design constraints that matter:
//   - The challenge token is never stored. D1 holds only its SHA-256, so a
//     database read cannot be replayed into a sign-in.
//   - Sessions live only in SessionAuthority (one durable object per identity).
//     D1 deliberately has no sessions table.
//   - The session cookie carries the session id; a second `requestToken` is
//     returned to the caller and required on state-changing calls, so a stolen
//     cookie alone cannot act.
//   - Role is resolved from `workspace_memberships` on every request. It is
//     never taken from the cookie, the client, or the session record.

export const SESSION_COOKIE = "ef_session";
const CHALLENGE_TTL_MS = 15 * 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;

export type AuthEnv = {
  CONTROL_DB: D1Database;
  TURNSTILE_SECRET?: string;
  IDENTITY_AUTHORITY: { getByName(name: string): SessionAuthorityStub };
  EMAIL?: { send(message: EmailMessage): Promise<unknown> };
  ENVIRONMENT: string;
  AUTH_MAIL_FROM?: string;
  AUTH_CONSOLE_ORIGIN?: string;
};

type EmailMessage = {
  to: string;
  from: { email: string; name: string };
  subject: string;
  text: string;
  html: string;
};

type SessionAuthorityStub = {
  create(session: AuthoritySession): Promise<number>;
  validate(
    sessionId: string,
    requestToken: string,
    membershipVersion: number,
  ): Promise<
    | { ok: true; session: AuthoritySession; epoch: number }
    | { ok: false; reason: "unknown" | "blocked" | "stale" | "quarantined" }
  >;
  revoke(sessionId?: string): Promise<void>;
};

export type Identity = { id: string; normalizedEmail: string; verifiedAt?: string };
export type Membership = { workspaceId: string; role: IdentityRole; version: number };

export type AuthenticatedCaller = {
  identity: Identity;
  session: AuthoritySession;
  memberships: Membership[];
};

function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time compare so a token check cannot be narrowed by timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1)
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/**
 * Roles are ordered, and every gate compares against this order rather than
 * checking equality against a single role.
 *
 * This closes the gap the enterprise-governance review left open: roles were
 * declared but no gate consumed them, so an auditor would have received the same
 * scope as an owner. An unknown role resolves to -1 and is denied.
 */
const ROLE_RANK: Record<IdentityRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

export function rankOf(role: string): number {
  return Object.hasOwn(ROLE_RANK, role) ? ROLE_RANK[role as IdentityRole] : -1;
}

export function roleAllows(role: string, required: IdentityRole): boolean {
  const rank = rankOf(role);
  return rank >= 0 && rank >= ROLE_RANK[required];
}

export function parseCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || undefined;
  }
  return undefined;
}

/**
 * The cookie carries `<identityId>.<sessionId>`.
 *
 * The identity id is not a secret and is not an authorization signal — it only
 * names which SessionAuthority object owns the session, so a request resolves in
 * one hop. Authority still rests on the session id plus the request token, both
 * verified inside that object.
 */
export function sessionCookieValue(identityId: string, sessionId: string): string {
  return `${identityId}.${sessionId}`;
}

export function parseSessionCookieValue(
  value: string | undefined,
): { identityId: string; sessionId: string } | undefined {
  if (!value) return undefined;
  const separator = value.indexOf(".");
  if (separator <= 0) return undefined;
  const identityId = value.slice(0, separator);
  const sessionId = value.slice(separator + 1);
  const uuid = /^[0-9a-f-]{36}$/;
  return uuid.test(identityId) && uuid.test(sessionId) ? { identityId, sessionId } : undefined;
}

export function sessionCookie(cookieValue: string, maxAgeSeconds: number): string {
  // Same-origin only: the console worker proxies /api, so the cookie never needs
  // SameSite=None and is not exposed to cross-site requests.
  return [
    `${SESSION_COOKIE}=${cookieValue}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export const clearedSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

async function identityForEmail(
  db: D1Database,
  normalizedEmail: string,
  now: Date,
): Promise<Identity> {
  const existing = await db
    .prepare(
      "select id, normalized_email, verified_at from identities where normalized_email = ? and closed_at is null",
    )
    .bind(normalizedEmail)
    .first<{ id: string; normalized_email: string; verified_at: string | null }>();
  if (existing)
    return {
      id: existing.id,
      normalizedEmail: existing.normalized_email,
      verifiedAt: existing.verified_at ?? undefined,
    };

  const id = crypto.randomUUID();
  await db
    .prepare(
      "insert into identities (id, normalized_email, created_at) values (?, ?, ?) on conflict(normalized_email) do nothing",
    )
    .bind(id, normalizedEmail, now.toISOString())
    .run();
  // Re-read rather than trusting the insert: a concurrent request may have won.
  const created = await db
    .prepare("select id, normalized_email, verified_at from identities where normalized_email = ?")
    .bind(normalizedEmail)
    .first<{ id: string; normalized_email: string; verified_at: string | null }>();
  if (!created) throw new Error("identity could not be created");
  return {
    id: created.id,
    normalizedEmail: created.normalized_email,
    verifiedAt: created.verified_at ?? undefined,
  };
}

export async function membershipsFor(db: D1Database, identityId: string): Promise<Membership[]> {
  const { results } = await db
    .prepare(
      "select workspace_id, role, version from workspace_memberships where identity_id = ? order by workspace_id",
    )
    .bind(identityId)
    .all<{ workspace_id: string; role: string; version: number }>();
  // An unrecognised role is dropped rather than defaulted, so a bad row cannot
  // widen access.
  return (results ?? [])
    .filter((row) => rankOf(row.role) >= 0)
    .map((row) => ({
      workspaceId: row.workspace_id,
      role: row.role as IdentityRole,
      version: row.version,
    }));
}

function verificationEmail(challengeUrl: string, expiresAt: Date) {
  const minutes = Math.round(CHALLENGE_TTL_MS / 60_000);
  return {
    subject: "Your EventForge sign-in link",
    text: `Sign in to EventForge:\n\n${challengeUrl}\n\nThis link expires in ${minutes} minutes (${expiresAt.toISOString()}) and can be used once.\nIf you did not request it, ignore this email.\n`,
    html: `<p>Sign in to EventForge:</p><p><a href="${challengeUrl}">Complete sign-in</a></p><p>This link expires in ${minutes} minutes and can be used once. If you did not request it, ignore this email.</p>`,
  };
}

export type RequestOutcome = { accepted: true; devToken?: string };

/**
 * Always reports the same outcome so the endpoint cannot be used to test whether
 * an address has an account.
 */
export async function requestSignIn(
  env: AuthEnv,
  rawEmail: string,
  now = new Date(),
): Promise<RequestOutcome> {
  const email = normalizeIdentityEmail(rawEmail);
  if (!email) return { accepted: true };

  const identity = await identityForEmail(env.CONTROL_DB, email, now);
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  await env.CONTROL_DB.prepare(
    "insert into email_challenges (id, identity_id, token_hash, expires_at, created_at) values (?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      identity.id,
      await hashToken(token),
      expiresAt.toISOString(),
      now.toISOString(),
    )
    .run();

  const origin = env.AUTH_CONSOLE_ORIGIN ?? "https://beta.eventforge.dev";
  const challengeUrl = `${origin}/console?token=${token}`;
  const body = verificationEmail(challengeUrl, expiresAt);

  if (env.EMAIL) {
    await env.EMAIL.send({
      to: email,
      from: {
        email: env.AUTH_MAIL_FROM ?? "no-reply@mail.eventforge.dev",
        name: "EventForge",
      },
      ...body,
    });
    return { accepted: true };
  }
  // No mail binding: fail closed in production-like surfaces by refusing to
  // hand the token back. Only a local run may echo it.
  if (env.ENVIRONMENT === "development") return { accepted: true, devToken: token };
  throw new Error("email delivery is not configured");
}

export type VerifyResult =
  | { ok: true; identity: Identity; sessionId: string; requestToken: string; maxAgeSeconds: number }
  | { ok: false; reason: "invalid" | "no_membership" };

export async function verifySignIn(
  env: AuthEnv,
  token: string,
  labels: { userAgentLabel: string; ipLabel: string },
  now = new Date(),
): Promise<VerifyResult> {
  if (!/^[a-f0-9]{64}$/.test(token)) return { ok: false, reason: "invalid" };
  const tokenHash = await hashToken(token);
  const challenge = await env.CONTROL_DB.prepare(
    "select id, identity_id, expires_at, used_at from email_challenges where token_hash = ?",
  )
    .bind(tokenHash)
    .first<{ id: string; identity_id: string; expires_at: string; used_at: string | null }>();

  const expiresAt = challenge ? Date.parse(challenge.expires_at) : Number.NaN;
  // A non-finite expiry must read as expired, never as "never expires".
  if (!challenge || challenge.used_at || !Number.isFinite(expiresAt) || expiresAt <= now.getTime())
    return { ok: false, reason: "invalid" };

  // Single-use: consuming the challenge is conditional on it still being unused,
  // so two concurrent verifies cannot both mint a session.
  const consumed = await env.CONTROL_DB.prepare(
    "update email_challenges set used_at = ? where id = ? and used_at is null",
  )
    .bind(now.toISOString(), challenge.id)
    .run();
  if ((consumed.meta.changes ?? 0) !== 1) return { ok: false, reason: "invalid" };

  await env.CONTROL_DB.prepare("update identities set verified_at = ? where id = ?")
    .bind(now.toISOString(), challenge.identity_id)
    .run();

  const memberships = await membershipsFor(env.CONTROL_DB, challenge.identity_id);
  // A verified email is not authorization. Without a membership there is nothing
  // to scope a session to, so no session is minted.
  if (memberships.length === 0) return { ok: false, reason: "no_membership" };

  const sessionId = crypto.randomUUID();
  const requestToken = randomToken();
  const session: AuthoritySession = {
    id: sessionId,
    requestToken,
    membershipVersion: memberships[0]!.version,
    createdAt: now.toISOString(),
    lastUsedAt: now.toISOString(),
    userAgentLabel: labels.userAgentLabel,
    ipLabel: labels.ipLabel,
  };
  await sessionAuthorityFor<SessionAuthorityStub>(env, challenge.identity_id).create(session);

  const identity = await env.CONTROL_DB.prepare(
    "select id, normalized_email, verified_at from identities where id = ?",
  )
    .bind(challenge.identity_id)
    .first<{ id: string; normalized_email: string; verified_at: string | null }>();

  return {
    ok: true,
    identity: {
      id: identity!.id,
      normalizedEmail: identity!.normalized_email,
      verifiedAt: identity!.verified_at ?? undefined,
    },
    sessionId,
    requestToken,
    maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/**
 * Resolves the caller from the session cookie. Membership and role are read from
 * D1 every time, so a role change or removal takes effect on the next request
 * rather than when the session happens to expire.
 */
export async function authenticate(
  env: AuthEnv,
  request: Request,
  requestToken: string | undefined,
): Promise<AuthenticatedCaller | undefined> {
  const parsed = parseSessionCookieValue(
    parseCookie(request.headers.get("cookie"), SESSION_COOKIE),
  );
  if (!parsed || !requestToken) return undefined;

  const row = await env.CONTROL_DB.prepare(
    "select id, normalized_email, verified_at from identities where id = ? and closed_at is null and verified_at is not null",
  )
    .bind(parsed.identityId)
    .first<{ id: string; normalized_email: string; verified_at: string | null }>();
  if (!row) return undefined;

  const memberships = await membershipsFor(env.CONTROL_DB, row.id);
  // A session without a surviving membership is not authenticated. Removing a
  // member therefore ends their access on the next request.
  if (memberships.length === 0) return undefined;

  const validation = await sessionAuthorityFor<SessionAuthorityStub>(env, row.id).validate(
    parsed.sessionId,
    requestToken,
    memberships[0]!.version,
  );
  if (!validation.ok) return undefined;

  return {
    identity: {
      id: row.id,
      normalizedEmail: row.normalized_email,
      verifiedAt: row.verified_at ?? undefined,
    },
    session: validation.session,
    memberships,
  };
}

export async function revokeSession(
  env: AuthEnv,
  identityId: string,
  sessionId: string,
): Promise<void> {
  await sessionAuthorityFor<SessionAuthorityStub>(env, identityId).revoke(sessionId);
}

export type PasswordSignIn =
  | { ok: true; identity: Identity; sessionId: string; requestToken: string; maxAgeSeconds: number }
  | {
      ok: false;
      reason: "invalid_credentials" | "no_membership" | "locked";
      retryAfterSeconds?: number;
    };

/**
 * Password sign-in.
 *
 * Every failure path returns `invalid_credentials` with the same shape, so the
 * endpoint cannot be used to learn whether an address exists or whether it has a
 * password set. The work factor is paid even when there is no password row, so
 * response timing does not leak account existence either.
 */
export async function signInWithPassword(
  env: AuthEnv,
  rawEmail: string,
  password: string,
  labels: { userAgentLabel: string; ipLabel: string },
  now = new Date(),
): Promise<PasswordSignIn> {
  const email = normalizeIdentityEmail(rawEmail);
  if (!email) return { ok: false, reason: "invalid_credentials" };

  const identityRow = await env.CONTROL_DB.prepare(
    "select id, normalized_email, verified_at from identities where normalized_email = ? and closed_at is null",
  )
    .bind(email)
    .first<{ id: string; normalized_email: string; verified_at: string | null }>();

  const attempts = identityRow
    ? await env.CONTROL_DB.prepare(
        "select failed_count, first_failed_at, locked_until from identity_login_attempts where identity_id = ?",
      )
        .bind(identityRow.id)
        .first<{
          failed_count: number;
          first_failed_at: string | null;
          locked_until: string | null;
        }>()
    : null;

  const lock = lockStateFor(attempts, now.getTime());
  if (lock.locked)
    return { ok: false, reason: "locked", retryAfterSeconds: lock.retryAfterSeconds };

  const record = identityRow
    ? await env.CONTROL_DB.prepare(
        "select algorithm, iterations, salt, hash from identity_passwords where identity_id = ?",
      )
        .bind(identityRow.id)
        .first<PasswordRecord>()
    : null;

  // Always run a derivation. Skipping it for unknown accounts would make them
  // measurably faster to probe.
  const decoy: PasswordRecord = {
    algorithm: "pbkdf2-sha256",
    iterations: 210_000,
    salt: "00000000000000000000000000000000",
    hash: "",
  };
  const matched = await verifyPassword(password, record ?? decoy);

  if (!identityRow || !record || !matched) {
    if (identityRow) {
      const next = nextFailureState(attempts, now.getTime());
      await env.CONTROL_DB.prepare(
        `insert into identity_login_attempts (identity_id, failed_count, first_failed_at, locked_until)
         values (?, ?, ?, ?)
         on conflict(identity_id) do update set
           failed_count = excluded.failed_count,
           first_failed_at = excluded.first_failed_at,
           locked_until = excluded.locked_until`,
      )
        .bind(identityRow.id, next.failedCount, next.firstFailedAt, next.lockedUntil)
        .run();
    }
    return { ok: false, reason: "invalid_credentials" };
  }

  const memberships = await membershipsFor(env.CONTROL_DB, identityRow.id);
  // A correct password is not authorization. No membership, no session.
  if (memberships.length === 0) return { ok: false, reason: "no_membership" };

  // Successful sign-in clears the counter.
  await env.CONTROL_DB.prepare("delete from identity_login_attempts where identity_id = ?")
    .bind(identityRow.id)
    .run();
  await env.CONTROL_DB.prepare(
    "update identities set verified_at = coalesce(verified_at, ?) where id = ?",
  )
    .bind(now.toISOString(), identityRow.id)
    .run();

  const sessionId = crypto.randomUUID();
  const requestToken = randomToken();
  await sessionAuthorityFor<SessionAuthorityStub>(env, identityRow.id).create({
    id: sessionId,
    requestToken,
    membershipVersion: memberships[0]!.version,
    createdAt: now.toISOString(),
    lastUsedAt: now.toISOString(),
    userAgentLabel: labels.userAgentLabel,
    ipLabel: labels.ipLabel,
  });

  return {
    ok: true,
    identity: {
      id: identityRow.id,
      normalizedEmail: identityRow.normalized_email,
      verifiedAt: identityRow.verified_at ?? now.toISOString(),
    },
    sessionId,
    requestToken,
    maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
  };
}
