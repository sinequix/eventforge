// Password credentials and Turnstile verification for hosted sign-in.
//
// The identity model was passwordless, so this is additive: an identity may have
// no password row at all, and the email-link path stays as the recovery route
// (there is no other way to reset a password you cannot remember).

// workerd refuses PBKDF2 above 100k iterations:
//   "Pbkdf2 failed: iteration counts above 100000 are not supported"
// so this is pinned to the platform maximum, not to OWASP's recommended 210k.
//
// That is a real weakening versus the recommendation and is compensated for
// elsewhere rather than ignored: a 12-character minimum, lockout after 8 failed
// attempts in an hour, and a captcha in front of the endpoint. Argon2 or bcrypt
// would be stronger but are not available in workerd without shipping WASM.
//
// Do not raise this above PBKDF2_MAX_ITERATIONS — the platform rejects it at
// runtime, which surfaces as a 500 on every sign-in rather than a build failure.
export const PBKDF2_MAX_ITERATIONS = 100_000;
export const PBKDF2_ITERATIONS = 100_000;
const ALGORITHM = "pbkdf2-sha256";
const KEY_LENGTH_BITS = 256;

const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60_000;
const ATTEMPT_WINDOW_MS = 60 * 60_000;

export type PasswordRecord = {
  algorithm: string;
  iterations: number;
  salt: string;
  hash: string;
};

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    KEY_LENGTH_BITS,
  );
  return toHex(bits);
}

/**
 * Minimum policy. Deliberately length-first: a length floor buys more than
 * character-class rules, which mostly push people toward `Password1!`.
 */
export function passwordComplaint(password: string): string | undefined {
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 256) return "Use at most 256 characters.";
  if (!/[^\s]/.test(password)) return "Password cannot be only whitespace.";
  return undefined;
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return {
    algorithm: ALGORITHM,
    iterations: PBKDF2_ITERATIONS,
    salt: toHex(salt.buffer),
    hash: await derive(password, salt, PBKDF2_ITERATIONS),
  };
}

/** Constant-time comparison; a length mismatch still walks the shorter string. */
export function constantTimeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1)
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return diff === 0;
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  // An unknown algorithm must fail closed rather than fall through to a default.
  if (record.algorithm !== ALGORITHM) return false;
  if (!Number.isSafeInteger(record.iterations) || record.iterations < 100_000) return false;
  // A stored row above the platform cap would make deriveBits throw, taking the
  // whole request down with a 500. Refuse it as unverifiable instead — the
  // credential then has to be reset, which is the safe direction.
  if (record.iterations > PBKDF2_MAX_ITERATIONS) return false;
  if (!/^[a-f0-9]+$/.test(record.salt) || record.salt.length % 2 !== 0) return false;
  const candidate = await derive(password, fromHex(record.salt), record.iterations);
  return constantTimeEqual(candidate, record.hash);
}

export type LockState = { locked: boolean; retryAfterSeconds?: number };

/**
 * Pure lockout decision so the policy is testable without a database.
 *
 * Turnstile makes automation expensive but does not bound the number of guesses,
 * so attempts are counted server-side as well.
 */
export function lockStateFor(
  row: { failed_count: number; first_failed_at: string | null; locked_until: string | null } | null,
  now: number,
): LockState {
  if (!row) return { locked: false };
  const lockedUntil = row.locked_until ? Date.parse(row.locked_until) : Number.NaN;
  // A non-finite lock expiry must read as still locked, never as expired.
  if (row.locked_until && (!Number.isFinite(lockedUntil) || lockedUntil > now))
    return {
      locked: true,
      retryAfterSeconds: Number.isFinite(lockedUntil)
        ? Math.max(1, Math.ceil((lockedUntil - now) / 1000))
        : Math.ceil(LOCKOUT_MS / 1000),
    };
  return { locked: false };
}

export function nextFailureState(
  row: { failed_count: number; first_failed_at: string | null } | null,
  now: number,
): { failedCount: number; firstFailedAt: string; lockedUntil: string | null } {
  const firstFailedAt = row?.first_failed_at ? Date.parse(row.first_failed_at) : Number.NaN;
  // Outside the window (or unparseable) the counter restarts.
  const withinWindow = Number.isFinite(firstFailedAt) && now - firstFailedAt < ATTEMPT_WINDOW_MS;
  const failedCount = withinWindow ? (row?.failed_count ?? 0) + 1 : 1;
  return {
    failedCount,
    firstFailedAt: withinWindow
      ? new Date(firstFailedAt).toISOString()
      : new Date(now).toISOString(),
    lockedUntil:
      failedCount >= MAX_FAILED_ATTEMPTS ? new Date(now + LOCKOUT_MS).toISOString() : null,
  };
}

export const MAX_ATTEMPTS = MAX_FAILED_ATTEMPTS;

export type TurnstileOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Whether a sign-in must carry a solved captcha.
 *
 * Two conditions must BOTH hold to disable it, and production can never satisfy
 * the first:
 *   1. the environment is not production, and
 *   2. AUTH_CAPTCHA_DISABLED is exactly "true".
 *
 * Written this way on purpose. Keying only off the flag would mean a stray
 * variable in the production config silently removes the control; keying only off
 * the environment would remove it from every non-production deploy whether or not
 * anyone asked. Absence of a secret still does NOT disable the captcha — that path
 * fails closed in verifyTurnstile, so a lost secret cannot be mistaken for a
 * deliberate opt-out.
 */
export function captchaRequired(env: {
  ENVIRONMENT?: string;
  AUTH_CAPTCHA_DISABLED?: string;
}): boolean {
  const nonProduction = env.ENVIRONMENT !== "production";
  return !(nonProduction && env.AUTH_CAPTCHA_DISABLED === "true");
}

/**
 * Server-side Turnstile verification. The widget response is worthless until
 * siteverify confirms it, so a missing token or a failed check denies.
 */
export async function verifyTurnstile(
  secret: string | undefined,
  token: string | undefined,
  remoteIp: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileOutcome> {
  // No secret configured means the check cannot be performed. Fail closed rather
  // than silently accepting every sign-in.
  if (!secret) return { ok: false, reason: "captcha_unconfigured" };
  if (!token) return { ok: false, reason: "captcha_missing" };

  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (remoteIp) body.append("remoteip", remoteIp);

  let payload: { success?: boolean; "error-codes"?: string[] };
  try {
    const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    payload = (await response.json()) as typeof payload;
  } catch {
    return { ok: false, reason: "captcha_unavailable" };
  }
  return payload.success === true
    ? { ok: true }
    : { ok: false, reason: (payload["error-codes"] ?? ["captcha_failed"]).join(",") };
}
