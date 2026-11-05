import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  STATE_COLLECTIONS,
  type EventForgeStore,
  type StateChange,
  type StateCollection,
  type StateSnapshot,
} from "@eventforge/core";

type Logger = {
  info: (object: Record<string, unknown>, message: string) => void;
  warn: (object: Record<string, unknown>, message: string) => void;
  error: (object: Record<string, unknown>, message: string) => void;
};

export type StateStoreStatus = {
  mode: "memory" | "cloudflare";
  host?: string;
  hydrated?: boolean;
  connected?: boolean;
  pending?: number;
  consecutiveFailures?: number;
  lastFlushAt?: string;
  lastError?: string;
  spool?: boolean;
};

export type CloudflareStateOptions = {
  url: string;
  token: string;
  spoolPath?: string;
  fetch?: typeof fetch;
  log?: Logger;
  batchSize?: number;
  maxBatchBytes?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function validateStateUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password)
    throw new Error("EVENTFORGE_STATE_URL must not embed credentials.");
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)))
    return url;
  throw new Error("EVENTFORGE_STATE_URL must use https (http only on loopback).");
}

class StateHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StateHttpError";
  }
}

/**
 * Write-through persistence of the in-memory store into the eventforge-state Worker
 * (one SQLite Durable Object per workspace). The in-memory store stays the read path.
 * Writes are queued, coalesced per record, spooled to a local file until acknowledged,
 * and retried with backoff, so an unreachable store never blocks a request or drops data.
 */
export class CloudflareStateSync {
  readonly #base: URL;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #log?: Logger;
  readonly #spoolPath?: string;
  readonly #batchSize: number;
  readonly #maxBatchBytes: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pending = new Map<string, StateChange>();
  readonly #registered = new Set<string>();
  #unsubscribe?: () => void;
  #flushing?: Promise<void>;
  #timer?: NodeJS.Timeout;
  #closed = false;
  #status: StateStoreStatus;

  constructor(options: CloudflareStateOptions) {
    if (!options.token) throw new Error("EVENTFORGE_STATE_TOKEN is required.");
    this.#base = validateStateUrl(options.url);
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#log = options.log;
    this.#spoolPath = options.spoolPath;
    this.#batchSize = options.batchSize ?? 200;
    this.#maxBatchBytes = options.maxBatchBytes ?? 3_000_000;
    this.#baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.#maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#status = {
      mode: "cloudflare",
      host: this.#base.host,
      hydrated: false,
      connected: false,
      pending: 0,
      consecutiveFailures: 0,
      spool: Boolean(this.#spoolPath),
    };
  }

  status(): StateStoreStatus {
    return { ...this.#status, pending: this.#pending.size };
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.#fetch(new URL(path, this.#base), {
      ...init,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(this.#timeoutMs),
      redirect: "error",
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string") message += `: ${parsed.error.slice(0, 200)}`;
      } catch {
        // Keep the status-only message.
      }
      throw new StateHttpError(response.status, message);
    }
    return text ? (JSON.parse(text) as unknown) : undefined;
  }

  /** Read every workspace's records (oldest first) and merge any unacknowledged spool on top. */
  async loadSnapshot(): Promise<StateSnapshot> {
    const listed = (await this.#request("/v1/workspaces")) as { workspaces?: string[] };
    const snapshot: Record<StateCollection, unknown[]> = Object.fromEntries(
      STATE_COLLECTIONS.map((name) => [name, []]),
    ) as unknown as Record<StateCollection, unknown[]>;
    for (const workspace of listed.workspaces ?? []) {
      let after = 0;
      for (;;) {
        const page = (await this.#request(
          `/v1/workspaces/${encodeURIComponent(workspace)}/records?after=${after}&limit=1000`,
        )) as {
          records: Array<{ collection: StateCollection; body: unknown }>;
          next: number | null;
        };
        for (const record of page.records)
          if (STATE_COLLECTIONS.includes(record.collection))
            snapshot[record.collection].push(record.body);
        if (page.next === null) break;
        after = page.next;
      }
    }
    for (const change of this.#readSpool()) {
      const items = snapshot[change.collection] as Array<{ id?: string }>;
      const index = items.findIndex((item) => item.id === change.id);
      if (index >= 0) items[index] = change.body as { id?: string };
      else items.push(change.body as { id?: string });
      this.#pending.set(this.#key(change), change);
    }
    return snapshot as StateSnapshot;
  }

  /** Hydrate the store, retrying until `deadlineMs`; throws so the process fails loudly instead of starting empty. */
  async hydrate(store: EventForgeStore, deadlineMs = 60_000): Promise<void> {
    const started = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      try {
        const snapshot = await this.loadSnapshot();
        store.hydrate(snapshot);
        this.#status.hydrated = true;
        this.#status.connected = true;
        this.#status.lastError = undefined;
        this.#log?.info(
          {
            store: this.#base.host,
            events: snapshot.events?.length ?? 0,
            runs: snapshot.runs?.length ?? 0,
            actions: snapshot.actions?.length ?? 0,
            replayed: this.#pending.size,
          },
          "control-plane state hydrated from Cloudflare",
        );
        return;
      } catch (error) {
        this.#status.lastError = error instanceof Error ? error.message : "hydrate failed";
        this.#log?.warn({ err: error, attempt, store: this.#base.host }, "state hydrate failed");
        if (Date.now() - started >= deadlineMs)
          throw new Error(
            `Could not hydrate state from ${this.#base.host}; refusing to start empty.`,
          );
        await this.#sleep(Math.min(this.#maxBackoffMs, this.#baseBackoffMs * 2 ** (attempt - 1)));
      }
    }
  }

  /** Start persisting every store mutation. Call after hydrate(). */
  attach(store: EventForgeStore): void {
    this.#unsubscribe = store.subscribeChanges((change) => this.enqueue(change));
    if (this.#pending.size) this.#schedule(0);
  }

  #key(change: StateChange): string {
    return `${change.workspaceId}\u0000${change.collection}\u0000${change.id}`;
  }

  enqueue(change: StateChange): void {
    const key = this.#key(change);
    this.#pending.delete(key); // re-insert so the newest version keeps write order
    this.#pending.set(key, change);
    if (this.#spoolPath) {
      try {
        appendFileSync(this.#spoolPath, `${JSON.stringify(change)}\n`, { mode: 0o600 });
      } catch (error) {
        this.#log?.error({ err: error }, "state spool append failed");
      }
    }
    this.#schedule(0);
  }

  #readSpool(): StateChange[] {
    if (!this.#spoolPath || !existsSync(this.#spoolPath)) return [];
    const changes: StateChange[] = [];
    for (const line of readFileSync(this.#spoolPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const change = JSON.parse(line) as StateChange;
        if (STATE_COLLECTIONS.includes(change.collection) && change.id && change.workspaceId)
          changes.push(change);
      } catch {
        // A torn last line from a crash is ignored; earlier lines are intact.
      }
    }
    return changes;
  }

  #truncateSpool(): void {
    if (!this.#spoolPath) return;
    try {
      writeFileSync(this.#spoolPath, "", { mode: 0o600 });
    } catch (error) {
      this.#log?.error({ err: error }, "state spool truncate failed");
    }
  }

  #schedule(delayMs: number): void {
    if (this.#closed || this.#timer || this.#flushing) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, delayMs);
    this.#timer.unref?.();
  }

  /** Send everything pending. Resolves after one pass; failures are retried on a backoff timer. */
  flush(): Promise<void> {
    if (this.#flushing) return this.#flushing;
    this.#flushing = this.#flushPass().finally(() => {
      this.#flushing = undefined;
      if (this.#pending.size && !this.#closed) {
        const failures = this.#status.consecutiveFailures ?? 0;
        this.#schedule(
          failures ? Math.min(this.#maxBackoffMs, this.#baseBackoffMs * 2 ** (failures - 1)) : 0,
        );
      }
    });
    return this.#flushing;
  }

  async #flushPass(): Promise<void> {
    while (this.#pending.size) {
      const first = this.#pending.values().next().value as StateChange;
      const workspace = first.workspaceId;
      const batch: Array<[string, StateChange]> = [];
      let bytes = 0;
      for (const entry of this.#pending) {
        if (entry[1].workspaceId !== workspace) continue;
        const size = JSON.stringify(entry[1].body).length;
        if (batch.length && (batch.length >= this.#batchSize || bytes + size > this.#maxBatchBytes))
          break;
        batch.push(entry);
        bytes += size;
      }
      const register = this.#registered.has(workspace) ? "" : "?register=1";
      try {
        await this.#request(`/v1/workspaces/${encodeURIComponent(workspace)}/changes${register}`, {
          method: "POST",
          body: JSON.stringify({
            changes: batch.map(([, change]) => ({
              collection: change.collection,
              id: change.id,
              body: change.body,
            })),
          }),
        });
      } catch (error) {
        const failures = (this.#status.consecutiveFailures ?? 0) + 1;
        this.#status.consecutiveFailures = failures;
        this.#status.connected = false;
        this.#status.lastError = error instanceof Error ? error.message : "write failed";
        this.#log?.warn(
          { err: error, pending: this.#pending.size, failures, store: this.#base.host },
          "state write failed; queued for retry",
        );
        return;
      }
      this.#registered.add(workspace);
      for (const [key, change] of batch)
        if (this.#pending.get(key) === change) this.#pending.delete(key);
      this.#status.consecutiveFailures = 0;
      this.#status.connected = true;
      this.#status.lastError = undefined;
      this.#status.lastFlushAt = new Date().toISOString();
    }
    this.#truncateSpool();
  }

  /** Stop listening and try to drain the queue for up to `timeoutMs`. */
  async close(timeoutMs = 5_000): Promise<void> {
    this.#unsubscribe?.();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const deadline = Date.now() + timeoutMs;
    while (this.#pending.size && Date.now() < deadline) {
      await this.flush();
      if (this.#pending.size) await this.#sleep(Math.min(250, Math.max(0, deadline - Date.now())));
    }
    this.#closed = true;
    if (this.#pending.size)
      this.#log?.warn(
        { pending: this.#pending.size, spooled: Boolean(this.#spoolPath) },
        "state writes still pending at shutdown",
      );
  }
}

export function createStateSyncFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
  log?: Logger,
): CloudflareStateSync | undefined {
  const mode = environment.EVENTFORGE_STORE ?? "memory";
  if (mode === "memory") return undefined;
  if (mode !== "cloudflare") throw new Error("EVENTFORGE_STORE must be memory or cloudflare.");
  const url = environment.EVENTFORGE_STATE_URL;
  const token = environment.EVENTFORGE_STATE_TOKEN;
  if (!url || !token)
    throw new Error(
      "EVENTFORGE_STORE=cloudflare requires EVENTFORGE_STATE_URL and EVENTFORGE_STATE_TOKEN.",
    );
  const spoolPath = environment.EVENTFORGE_STATE_SPOOL || undefined;
  if (spoolPath) mkdirSync(dirname(spoolPath), { recursive: true, mode: 0o700 });
  return new CloudflareStateSync({ url, token, spoolPath, log });
}
