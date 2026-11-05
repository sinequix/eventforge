import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { parseChanges } from "../src/validation.js";

const TOKEN = "state-test-token-0123456789";
const persistDir = mkdtempSync(join(tmpdir(), "eventforge-state-"));
type Worker = Awaited<ReturnType<typeof unstable_startWorker>>;

async function start(): Promise<Worker> {
  const worker = await unstable_startWorker({
    config: new URL("../wrangler.jsonc", import.meta.url).pathname,
    bindings: { STATE_API_TOKEN: { type: "secret_text", value: TOKEN } },
    dev: {
      persist: persistDir,
      server: { hostname: "127.0.0.1", port: 0 },
      inspector: false,
      remote: false,
    },
  });
  await worker.ready;
  return worker;
}

async function call(
  worker: Worker,
  path: string,
  init: { method?: string; body?: string } = {},
  token = TOKEN,
) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.body) headers["content-type"] = "application/json";
  const response = await worker.fetch(`http://state.test${path}`, { ...init, headers });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const event = (id: string, dedupeKey: string) => ({
  collection: "events",
  id,
  body: { id, dedupeKey, workspaceId: "w1", payload: { n: id } },
});

describe("eventforge-state Worker (local workerd)", () => {
  let worker: Worker;
  beforeAll(async () => {
    worker = await start();
  });
  afterAll(async () => {
    await worker?.dispose();
    rmSync(persistDir, { recursive: true, force: true });
  });

  it("serves health without auth and rejects missing or wrong tokens", async () => {
    expect((await call(worker, "/health", {}, "")).status).toBe(200);
    expect((await call(worker, "/v1/workspaces", {}, "")).status).toBe(401);
    expect((await call(worker, "/v1/workspaces", {}, "wrong-token")).status).toBe(401);
    expect((await call(worker, "/v1/workspaces")).status).toBe(200);
  });

  it("upserts records, dedupes events by delivery key, and pages in creation order", async () => {
    const first = await call(worker, "/v1/workspaces/w1/changes?register=1", {
      method: "POST",
      body: JSON.stringify({
        changes: [
          event("e1", "github:d-1"),
          { collection: "runs", id: "r1", body: { id: "r1", status: "running" } },
        ],
      }),
    });
    expect(first.body).toMatchObject({ applied: 2, skippedDuplicates: 0 });
    const second = await call(worker, "/v1/workspaces/w1/changes", {
      method: "POST",
      body: JSON.stringify({
        changes: [
          event("e2", "github:d-1"),
          { collection: "runs", id: "r1", body: { id: "r1", status: "waiting_for_approval" } },
        ],
      }),
    });
    expect(second.body).toMatchObject({ applied: 1, skippedDuplicates: 1 });
    const page = await call(worker, "/v1/workspaces/w1/records?limit=1");
    expect(page.body.records).toMatchObject([{ collection: "events", id: "e1" }]);
    const rest = await call(worker, `/v1/workspaces/w1/records?after=${page.body.next}`);
    expect(rest.body).toMatchObject({
      records: [{ collection: "runs", id: "r1", body: { status: "waiting_for_approval" } }],
      next: null,
    });
    expect((await call(worker, "/v1/workspaces")).body).toEqual({ workspaces: ["w1"] });
    expect((await call(worker, "/v1/workspaces/w1/counts")).body).toEqual({ events: 1, runs: 1 });
  });

  it("rejects malformed batches atomically", async () => {
    for (const body of [
      "not json",
      JSON.stringify({}),
      JSON.stringify({ changes: [{ collection: "secrets", id: "x", body: { id: "x" } }] }),
      JSON.stringify({ changes: [{ collection: "runs", id: "a", body: { id: "b" } }] }),
    ]) {
      const response = await call(worker, "/v1/workspaces/w1/changes", { method: "POST", body });
      expect(response.status).toBe(400);
    }
    expect((await call(worker, "/v1/workspaces/bad%20name/counts")).status).toBe(400);
    expect((await call(worker, "/v1/other")).status).toBe(404);
  });

  it("keeps state across a Worker restart", async () => {
    await worker.dispose();
    worker = await start();
    expect((await call(worker, "/v1/workspaces/w1/counts")).body).toEqual({ events: 1, runs: 1 });
    expect((await call(worker, "/v1/workspaces")).body).toEqual({ workspaces: ["w1"] });
  });
});

describe("parseChanges", () => {
  it("validates shape, collection, ids and batch size", () => {
    expect(parseChanges(null)).toBeTypeOf("string");
    expect(parseChanges({ changes: [1] })).toBeTypeOf("string");
    expect(
      parseChanges({ changes: [{ collection: "runs", id: "bad id", body: { id: "bad id" } }] }),
    ).toBeTypeOf("string");
    expect(parseChanges({ changes: [{ collection: "runs", id: "a", body: [] }] })).toBeTypeOf(
      "string",
    );
    expect(parseChanges({ changes: Array.from({ length: 501 }, () => ({})) })).toBeTypeOf("string");
    expect(parseChanges({ changes: [{ collection: "runs", id: "a", body: { id: "a" } }] })).toEqual(
      [{ collection: "runs", id: "a", body: { id: "a" } }],
    );
  });
});
