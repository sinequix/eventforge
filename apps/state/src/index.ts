import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_PAGE,
  MAX_BODY_BYTES,
  MAX_PAGE,
  MAX_RECORD_BYTES,
  WORKSPACE_PATTERN,
  parseChanges,
  type Change,
  type Collection,
  type StoredRecord,
} from "./validation.js";

export { COLLECTIONS, parseChanges, type Change, type Collection } from "./validation.js";

export interface Env {
  WORKSPACE_STATE: DurableObjectNamespace<WorkspaceState>;
  STATE_REGISTRY: DurableObjectNamespace<StateRegistry>;
  STATE_API_TOKEN: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function authorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const encoder = new TextEncoder();
  // Hash both sides so the comparison is constant time regardless of length.
  const [supplied, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(header.slice(7))),
    crypto.subtle.digest("SHA-256", encoder.encode(token)),
  ]);
  // Workers extension to SubtleCrypto (not in the DOM lib types).
  return (
    crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }
  ).timingSafeEqual(supplied, expected);
}

/** All persisted state for one workspace. Records are upserted by (collection, id); `seq` keeps creation order. */
export class WorkspaceState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS records (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          collection TEXT NOT NULL,
          id TEXT NOT NULL,
          dedupe_key TEXT,
          body TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (collection, id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS records_event_dedupe
          ON records (dedupe_key) WHERE collection = 'events' AND dedupe_key IS NOT NULL;
      `);
    });
  }

  /**
   * Apply a batch atomically. An event whose dedupe key already belongs to another
   * event id is skipped (the first delivery wins), so redeliveries never duplicate.
   */
  apply(changes: Change[]): { applied: number; skippedDuplicates: number; firstWrite: boolean } {
    let applied = 0;
    let skippedDuplicates = 0;
    const sql = this.ctx.storage.sql;
    const before = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM records").one().n;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const change of changes) {
        const body = JSON.stringify(change.body);
        if (body.length > MAX_RECORD_BYTES) throw new Error(`Record ${change.id} is too large.`);
        const dedupeKey =
          change.collection === "events"
            ? String((change.body as { dedupeKey?: unknown }).dedupeKey ?? "") || null
            : null;
        if (dedupeKey) {
          const owner = sql
            .exec<{ id: string }>(
              "SELECT id FROM records WHERE collection = 'events' AND dedupe_key = ?",
              dedupeKey,
            )
            .toArray()[0];
          if (owner && owner.id !== change.id) {
            skippedDuplicates += 1;
            continue;
          }
        }
        sql.exec(
          `INSERT INTO records (collection, id, dedupe_key, body, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (collection, id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
          change.collection,
          change.id,
          dedupeKey,
          body,
          now,
        );
        applied += 1;
      }
    });
    return { applied, skippedDuplicates, firstWrite: before === 0 && applied > 0 };
  }

  page(after: number, limit: number): { records: StoredRecord[]; next: number | null } {
    const rows = this.ctx.storage.sql
      .exec<{ seq: number; collection: Collection; id: string; body: string }>(
        "SELECT seq, collection, id, body FROM records WHERE seq > ? ORDER BY seq LIMIT ?",
        after,
        limit,
      )
      .toArray();
    return {
      records: rows.map((row) => ({
        collection: row.collection,
        id: row.id,
        seq: row.seq,
        body: JSON.parse(row.body) as unknown,
      })),
      next: rows.length === limit ? rows[rows.length - 1]!.seq : null,
    };
  }

  counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of this.ctx.storage.sql
      .exec<{ collection: string; n: number }>(
        "SELECT collection, COUNT(*) AS n FROM records GROUP BY collection",
      )
      .toArray())
      counts[row.collection] = row.n;
    return counts;
  }
}

/** Lists workspace names that have state, so a plane can hydrate all of them. */
export class StateRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS workspaces (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
      );
    });
  }

  add(name: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO workspaces (name, created_at) VALUES (?, ?) ON CONFLICT (name) DO NOTHING",
      name,
      Date.now(),
    );
  }

  list(): string[] {
    return this.ctx.storage.sql
      .exec<{ name: string }>("SELECT name FROM workspaces ORDER BY name")
      .toArray()
      .map((row) => row.name);
  }
}

function workspaceStub(env: Env, workspace: string) {
  return env.WORKSPACE_STATE.get(env.WORKSPACE_STATE.idFromName(`workspace:${workspace}`));
}

function registryStub(env: Env) {
  return env.STATE_REGISTRY.get(env.STATE_REGISTRY.idFromName("registry"));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true });
    if (!(await authorized(request, env.STATE_API_TOKEN)))
      return json({ error: "State API token required." }, 401);

    if (url.pathname === "/v1/workspaces" && request.method === "GET")
      return json({ workspaces: await registryStub(env).list() });

    const match = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/(changes|records|counts)$/);
    if (!match) return json({ error: "Not found." }, 404);
    const workspace = decodeURIComponent(match[1]!);
    if (!WORKSPACE_PATTERN.test(workspace)) return json({ error: "Invalid workspace." }, 400);
    const stub = workspaceStub(env, workspace);

    if (match[2] === "changes" && request.method === "POST") {
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > MAX_BODY_BYTES) return json({ error: "Body too large." }, 413);
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return json({ error: "Body too large." }, 413);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return json({ error: "Body must be JSON." }, 400);
      }
      const changes = parseChanges(body);
      if (typeof changes === "string") return json({ error: changes }, 400);
      try {
        const result = await stub.apply(changes);
        // Register on every write that created the workspace's first records; `add` is idempotent.
        if (result.firstWrite || url.searchParams.get("register") === "1")
          await registryStub(env).add(workspace);
        return json(result);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Write failed." }, 422);
      }
    }
    if (match[2] === "records" && request.method === "GET") {
      const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
      const limit = Math.min(
        MAX_PAGE,
        Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_PAGE) || DEFAULT_PAGE),
      );
      return json(await stub.page(after, limit));
    }
    if (match[2] === "counts" && request.method === "GET") return json(await stub.counts());
    return json({ error: "Method not allowed." }, 405);
  },
} satisfies ExportedHandler<Env>;
