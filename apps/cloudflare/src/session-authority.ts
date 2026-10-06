import { DurableObject } from "cloudflare:workers";

const AUTHORITY_SCHEMA_VERSION = "1";
const AUTHORITY_META_COLUMNS = ["key", "value"];
const AUTHORITY_SESSION_COLUMNS = [
  "id",
  "request_token",
  "membership_version",
  "created_at",
  "last_used_at",
  "user_agent_label",
  "ip_label",
];

export type AuthoritySession = {
  id: string;
  requestToken: string;
  membershipVersion: number;
  createdAt: string;
  lastUsedAt: string;
  userAgentLabel: string;
  ipLabel: string;
};

export type AuthorityValidation =
  | { ok: true; session: AuthoritySession; epoch: number }
  | { ok: false; reason: "unknown" | "blocked" | "stale" | "quarantined" };

export type AuthorityStorageSnapshot = {
  tables: string[];
  metaColumns: string[];
  sessionColumns: string[];
  metadata: Record<string, string>;
};

export type AuthorityStorageDisposition = "initialize" | "ready" | "quarantine";

function hasExactColumns(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && expected.every((column) => actual.includes(column));
}

/** Pure schema decision used by startup and tests to keep corruption handling deterministic. */
export function authorityStorageDisposition(
  snapshot: AuthorityStorageSnapshot,
): AuthorityStorageDisposition {
  const expectedTables = ["authority_meta", "sessions"];
  if (snapshot.tables.length === 0) return "initialize";
  if (
    snapshot.tables.length !== expectedTables.length ||
    !expectedTables.every((table) => snapshot.tables.includes(table)) ||
    !hasExactColumns(snapshot.metaColumns, AUTHORITY_META_COLUMNS) ||
    !hasExactColumns(snapshot.sessionColumns, AUTHORITY_SESSION_COLUMNS)
  )
    return "quarantine";

  const epoch = Number(snapshot.metadata.epoch);
  if (
    snapshot.metadata.schema_version !== AUTHORITY_SCHEMA_VERSION ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    !["0", "1"].includes(snapshot.metadata.blocked ?? "") ||
    !["0", "1"].includes(snapshot.metadata.quarantined ?? "")
  )
    return "quarantine";
  return "ready";
}

export function authorityObjectName(canonicalUserId: string): string {
  if (
    canonicalUserId.length === 0 ||
    canonicalUserId.length > 128 ||
    canonicalUserId !== canonicalUserId.trim()
  )
    throw new Error("canonical user identifier is invalid");
  return `identity:${canonicalUserId}`;
}

/** Production wiring must always resolve the namespace through this one-user selector. */
export function sessionAuthorityFor<T>(
  env: { IDENTITY_AUTHORITY: { getByName(name: string): T } },
  canonicalUserId: string,
): T {
  return env.IDENTITY_AUTHORITY.getByName(authorityObjectName(canonicalUserId));
}

/** One deterministic object per canonical user. It never authorizes D1 membership itself. */
export class SessionAuthority extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.initializeStorage());
  }

  private tableColumns(table: "authority_meta" | "sessions"): string[] {
    return this.ctx.storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .map((column) => column.name);
  }

  private storageSnapshot(): AuthorityStorageSnapshot {
    const tables = this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('authority_meta', 'sessions') ORDER BY name",
      )
      .toArray()
      .map((table) => table.name);
    if (!tables.includes("authority_meta") || !tables.includes("sessions"))
      return { tables, metaColumns: [], sessionColumns: [], metadata: {} };

    const metadata = Object.fromEntries(
      this.ctx.storage.sql
        .exec<{ key: string; value: string }>(
          "SELECT key, value FROM authority_meta WHERE key IN ('schema_version', 'epoch', 'blocked', 'quarantined')",
        )
        .toArray()
        .map((row) => [row.key, row.value]),
    );
    return {
      tables,
      metaColumns: this.tableColumns("authority_meta"),
      sessionColumns: this.tableColumns("sessions"),
      metadata,
    };
  }

  private initializeStorage(): void {
    const disposition = authorityStorageDisposition(this.storageSnapshot());
    if (disposition === "ready") return;

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS authority_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      if (disposition === "quarantine") {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO authority_meta (key, value) VALUES ('quarantined', '1')",
        );
        return;
      }
      this.ctx.storage.sql.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, request_token TEXT NOT NULL, membership_version INTEGER NOT NULL,
          created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, user_agent_label TEXT NOT NULL,
          ip_label TEXT NOT NULL
        );
      `);
      this.ctx.storage.sql.exec(
        "INSERT INTO authority_meta (key, value) VALUES ('schema_version', ?), ('epoch', '0'), ('blocked', '0'), ('quarantined', '0')",
        AUTHORITY_SCHEMA_VERSION,
      );
    });

    if (
      disposition === "initialize" &&
      authorityStorageDisposition(this.storageSnapshot()) !== "ready"
    ) {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO authority_meta (key, value) VALUES ('quarantined', '1')",
      );
    }
  }

  private meta(key: string): string {
    return (
      this.ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM authority_meta WHERE key = ?", key)
        .one()?.value ?? ""
    );
  }

  private assertHealthy(): void {
    if (this.meta("quarantined") === "1") throw new Error("session authority quarantined");
  }

  async create(session: AuthoritySession): Promise<number> {
    this.assertHealthy();
    if (this.meta("blocked") === "1") throw new Error("session authority blocked");
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions (id,request_token,membership_version,created_at,last_used_at,user_agent_label,ip_label) VALUES (?,?,?,?,?,?,?)",
      session.id,
      session.requestToken,
      session.membershipVersion,
      session.createdAt,
      session.lastUsedAt,
      session.userAgentLabel,
      session.ipLabel,
    );
    return Number(this.meta("epoch"));
  }

  async validate(
    sessionId: string,
    requestToken: string,
    membershipVersion: number,
  ): Promise<AuthorityValidation> {
    if (this.meta("quarantined") === "1") return { ok: false, reason: "quarantined" };
    if (this.meta("blocked") === "1") return { ok: false, reason: "blocked" };
    const session = this.ctx.storage.sql
      .exec<{
        id: string;
        request_token: string;
        membership_version: number;
        created_at: string;
        last_used_at: string;
        user_agent_label: string;
        ip_label: string;
      }>("SELECT * FROM sessions WHERE id = ?", sessionId)
      .toArray()[0];
    if (!session || session.request_token !== requestToken) return { ok: false, reason: "unknown" };
    const createdAt = Date.parse(session.created_at);
    if (
      !Number.isFinite(createdAt) ||
      createdAt > Date.now() ||
      Date.now() - createdAt >= 12 * 60 * 60_000
    ) {
      this.ctx.storage.sql.exec("DELETE FROM sessions WHERE id = ?", sessionId);
      return { ok: false, reason: "unknown" };
    }
    if (session.membership_version !== membershipVersion) return { ok: false, reason: "stale" };
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec("UPDATE sessions SET last_used_at = ? WHERE id = ?", now, sessionId);
    return {
      ok: true,
      epoch: Number(this.meta("epoch")),
      session: {
        id: session.id,
        requestToken: session.request_token,
        membershipVersion: session.membership_version,
        createdAt: session.created_at,
        lastUsedAt: now,
        userAgentLabel: session.user_agent_label,
        ipLabel: session.ip_label,
      },
    };
  }

  /** Revoke-first: block and rotate before D1 changes. A failed D1 write intentionally stays blocked. */
  async beginRevocation(): Promise<number> {
    this.assertHealthy();
    const epoch = Number(this.meta("epoch")) + 1;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO authority_meta (key, value) VALUES ('blocked', '1'), ('epoch', ?)",
      String(epoch),
    );
    return epoch;
  }

  async allowOnlyMembershipVersion(version: number): Promise<void> {
    this.assertHealthy();
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error("membership version is invalid");
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE membership_version <> ?", version);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO authority_meta (key, value) VALUES ('blocked', '0')",
    );
  }

  async revoke(sessionId?: string): Promise<void> {
    this.assertHealthy();
    if (sessionId) this.ctx.storage.sql.exec("DELETE FROM sessions WHERE id = ?", sessionId);
    else this.ctx.storage.sql.exec("DELETE FROM sessions");
  }

  /** Recovery must never resurrect credentials from restored storage. */
  async resetAfterRecovery(): Promise<number> {
    const epoch = Number(this.meta("epoch")) + 1;
    this.ctx.storage.sql.exec("DELETE FROM sessions");
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO authority_meta (key, value) VALUES ('epoch', ?), ('blocked', '0'), ('quarantined', '0'), ('schema_version', '1')",
      String(epoch),
    );
    return epoch;
  }
}
