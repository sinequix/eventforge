import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { unstable_startWorker } from "wrangler";
import { EventForgeStore, type StateChange } from "@eventforge/core";
import { builtinWorkflowId, createApp } from "../src/app.js";
import type { AgentRunner } from "../src/runner.js";
import {
  CloudflareStateSync,
  createStateSyncFromEnv,
  validateStateUrl,
} from "../src/state-sync.js";

const TOKEN = "plane-state-token-abcdef0123456789";
const SECRET = "state-webhook-secret";
const runner: AgentRunner = {
  investigate: async () => ({ threadId: "t", summary: "CI failed on a missing null guard." }),
};

function memoryLog() {
  const lines: string[] = [];
  const write = (object: Record<string, unknown>, message: string) =>
    lines.push(
      `${message} ${JSON.stringify(object, (_k, v) => (v instanceof Error ? v.message : v))}`,
    );
  return { lines, log: { info: write, warn: write, error: write } };
}

/** In-memory stand-in for the Worker API, with switchable failure. */
function fakeStateServer() {
  const records = new Map<string, Array<{ collection: string; id: string; body: unknown }>>();
  const registry = new Set<string>();
  let down = false;
  const seenAuth: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seenAuth.push(String((init?.headers as Record<string, string>)?.authorization));
    if (down) throw new TypeError("fetch failed");
    if (url.pathname === "/v1/workspaces")
      return Response.json({ workspaces: [...registry].sort() });
    const match = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/(changes|records)$/)!;
    const workspace = decodeURIComponent(match[1]!);
    const list = records.get(workspace) ?? [];
    records.set(workspace, list);
    if (match[2] === "changes") {
      if (url.searchParams.get("register") === "1") registry.add(workspace);
      const { changes } = JSON.parse(String(init?.body)) as {
        changes: Array<{ collection: string; id: string; body: unknown }>;
      };
      for (const change of changes) {
        const index = list.findIndex(
          (r) => r.collection === change.collection && r.id === change.id,
        );
        if (index >= 0) list[index] = change;
        else list.push(change);
      }
      return Response.json({ applied: changes.length, skippedDuplicates: 0 });
    }
    const after = Number(url.searchParams.get("after") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 500);
    const page = list.slice(after, after + limit).map((r, i) => ({ ...r, seq: after + i + 1 }));
    return Response.json({
      records: page,
      next: after + limit < list.length ? after + limit : null,
    });
  });
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    records,
    registry,
    seenAuth,
    setDown: (value: boolean) => {
      down = value;
    },
  };
}

const change = (id: string, status: string): StateChange => ({
  collection: "runs",
  id,
  workspaceId: "w1",
  body: { id, status },
});

describe("CloudflareStateSync (unit)", () => {
  it("validates configuration", () => {
    expect(createStateSyncFromEnv({})).toBeUndefined();
    expect(() => createStateSyncFromEnv({ EVENTFORGE_STORE: "redis" })).toThrow(
      "memory or cloudflare",
    );
    expect(() => createStateSyncFromEnv({ EVENTFORGE_STORE: "cloudflare" })).toThrow(
      "EVENTFORGE_STATE_URL",
    );
    expect(
      createStateSyncFromEnv({
        EVENTFORGE_STORE: "cloudflare",
        EVENTFORGE_STATE_URL: "https://state.example.test",
        EVENTFORGE_STATE_TOKEN: TOKEN,
      }),
    ).toBeInstanceOf(CloudflareStateSync);
    expect(() => validateStateUrl("http://state.example.test")).toThrow("https");
    expect(() => validateStateUrl("https://a:b@state.example.test")).toThrow("credentials");
    expect(validateStateUrl("http://127.0.0.1:8787").host).toBe("127.0.0.1:8787");
    expect(() => new CloudflareStateSync({ url: "https://x.test", token: "" })).toThrow();
  });

  it("coalesces writes, registers the workspace once, and reports status", async () => {
    const server = fakeStateServer();
    const sync = new CloudflareStateSync({
      url: "https://state.example.test",
      token: TOKEN,
      fetch: server.fetch,
    });
    sync.enqueue(change("r1", "running"));
    sync.enqueue(change("r1", "waiting_for_approval"));
    sync.enqueue(change("r2", "running"));
    await sync.flush();
    expect(server.records.get("w1")).toEqual([
      { collection: "runs", id: "r1", body: { id: "r1", status: "waiting_for_approval" } },
      { collection: "runs", id: "r2", body: { id: "r2", status: "running" } },
    ]);
    expect([...server.registry]).toEqual(["w1"]);
    expect(sync.status()).toMatchObject({
      mode: "cloudflare",
      connected: true,
      pending: 0,
      host: "state.example.test",
    });
    expect(server.seenAuth.every((value) => value === `Bearer ${TOKEN}`)).toBe(true);
    await sync.close();
  });

  it("queues and spools writes while the store is down, then replays them after a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ef-spool-"));
    const spoolPath = join(dir, "spool.jsonl");
    const server = fakeStateServer();
    const { lines, log } = memoryLog();
    try {
      server.setDown(true);
      const sync = new CloudflareStateSync({
        url: "https://state.example.test",
        token: TOKEN,
        fetch: server.fetch,
        spoolPath,
        log,
        baseBackoffMs: 60_000,
      });
      sync.enqueue(change("r1", "waiting_for_approval"));
      await sync.flush();
      expect(sync.status()).toMatchObject({ connected: false, pending: 1, consecutiveFailures: 1 });
      expect(sync.status().lastError).toContain("fetch failed");
      expect(readFileSync(spoolPath, "utf8")).toContain('"r1"');
      expect(lines.join("\n")).toContain("queued for retry");
      expect(lines.join("\n")).not.toContain(TOKEN);
      // Simulate a crash: the process dies with the write unacknowledged.

      server.setDown(false);
      const restarted = new CloudflareStateSync({
        url: "https://state.example.test",
        token: TOKEN,
        fetch: server.fetch,
        spoolPath,
      });
      const store = new EventForgeStore();
      await restarted.hydrate(store);
      expect(store.runs()).toMatchObject([{ id: "r1", status: "waiting_for_approval" }]);
      restarted.attach(store);
      await restarted.flush();
      expect(server.records.get("w1")).toMatchObject([{ id: "r1" }]);
      expect(readFileSync(spoolPath, "utf8")).toBe("");
      await restarted.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pages through large workspaces when hydrating", async () => {
    const server = fakeStateServer();
    const writer = new CloudflareStateSync({
      url: "https://state.example.test",
      token: TOKEN,
      fetch: server.fetch,
    });
    for (let i = 0; i < 1_205; i += 1) writer.enqueue(change(`r${i}`, "completed"));
    await writer.flush();
    const store = new EventForgeStore();
    await new CloudflareStateSync({
      url: "https://state.example.test",
      token: TOKEN,
      fetch: server.fetch,
    }).hydrate(store);
    expect(store.runs()).toHaveLength(1_205);
    expect(store.runs()[0]!.id).toBe("r1204");
  });

  it("refuses to start empty when the store stays unreachable", async () => {
    const server = fakeStateServer();
    server.setDown(true);
    const sync = new CloudflareStateSync({
      url: "https://state.example.test",
      token: TOKEN,
      fetch: server.fetch,
      sleep: async () => undefined,
    });
    await expect(sync.hydrate(new EventForgeStore(), 0)).rejects.toThrow("refusing to start empty");
    expect(sync.status()).toMatchObject({ hydrated: false });
  });

  it("gives built-in workflows stable UUIDs", () => {
    const id = builtinWorkflowId("demo-workspace", "ci-check-run");
    expect(id).toBe(builtinWorkflowId("demo-workspace", "ci-check-run"));
    expect(id).not.toBe(builtinWorkflowId("other", "ci-check-run"));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("control plane durable across restarts (real eventforge-state Worker on local workerd)", () => {
  const persistDir = mkdtempSync(join(tmpdir(), "ef-state-e2e-"));
  let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
  let baseUrl: string;
  const previous = { ...process.env };

  beforeAll(async () => {
    worker = await unstable_startWorker({
      config: new URL("../../state/wrangler.jsonc", import.meta.url).pathname,
      bindings: { STATE_API_TOKEN: { type: "secret_text", value: TOKEN } },
      dev: {
        persist: persistDir,
        server: { hostname: "127.0.0.1", port: 0 },
        inspector: false,
        remote: false,
      },
    });
    baseUrl = (await worker.url).toString();
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    process.env.EVENTFORGE_ALLOWED_REPOS = "sinequix/eventforge";
  }, 120_000);

  afterAll(async () => {
    await worker?.dispose();
    rmSync(persistDir, { recursive: true, force: true });
    process.env = previous;
  });

  async function boot() {
    const sync = new CloudflareStateSync({ url: baseUrl, token: TOKEN });
    const store = new EventForgeStore();
    await sync.hydrate(store, 10_000);
    sync.attach(store);
    const app = await createApp({
      store,
      runner,
      persistAudit: false,
      notifier: null,
      stateStatus: () => sync.status(),
    });
    return { app, sync, store };
  }

  const payload = JSON.stringify({
    action: "completed",
    workflow_run: {
      id: 1,
      name: "Quality",
      conclusion: "failure",
      html_url: "https://github.com/sinequix/eventforge/actions/runs/1",
    },
    repository: { full_name: "sinequix/eventforge" },
  });
  const deliver = (app: Awaited<ReturnType<typeof createApp>>) =>
    app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "redelivered-guid-1",
        "x-github-event": "workflow_run",
        "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`,
      },
    });

  it("restores events, runs, pending proposals and dedupe after a restart", async () => {
    const first = await boot();
    expect((await deliver(first.app)).statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [action] = (await first.app.inject({ method: "GET", url: "/actions" })).json();
    expect(action).toMatchObject({ status: "pending", type: "open_pull_request" });
    const before = {
      events: (await first.app.inject({ method: "GET", url: "/events" })).json(),
      runs: (await first.app.inject({ method: "GET", url: "/runs" })).json(),
      workflows: (await first.app.inject({ method: "GET", url: "/workflows" })).json().length,
      audit: (await first.app.inject({ method: "GET", url: "/audit" })).json().length,
    };
    const health = (await first.app.inject({ method: "GET", url: "/health" })).json();
    expect(health.store).toMatchObject({ mode: "cloudflare", hydrated: true });
    await first.app.close();
    await first.sync.close();

    const second = await boot();
    try {
      expect((await second.app.inject({ method: "GET", url: "/events" })).json()).toEqual(
        before.events,
      );
      expect((await second.app.inject({ method: "GET", url: "/runs" })).json()).toEqual(
        before.runs,
      );
      expect((await second.app.inject({ method: "GET", url: "/workflows" })).json()).toHaveLength(
        before.workflows,
      );
      expect(
        (await second.app.inject({ method: "GET", url: "/audit" })).json().length,
      ).toBeGreaterThanOrEqual(before.audit);
      expect((await second.app.inject({ method: "GET", url: "/actions" })).json()).toMatchObject([
        { id: action.id, status: "pending" },
      ]);
      const redelivered = await deliver(second.app);
      expect(redelivered.statusCode).toBe(200);
      expect(redelivered.json()).toMatchObject({ duplicate: true });

      const decision = await second.app.inject({
        method: "POST",
        url: `/actions/${action.id}/decision`,
        payload: { approved: false, version: action.version, reason: "durability test" },
      });
      expect(decision.statusCode).toBe(200);
      await second.sync.flush();
    } finally {
      await second.app.close();
      await second.sync.close();
    }

    const third = await boot();
    try {
      expect((await third.app.inject({ method: "GET", url: "/actions" })).json()).toMatchObject([
        { id: action.id, status: "rejected", decisionReason: "durability test" },
      ]);
      expect(existsSync(persistDir)).toBe(true);
    } finally {
      await third.app.close();
      await third.sync.close();
    }
  });
});
