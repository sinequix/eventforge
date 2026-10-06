import { describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/auth.js";
import { encryptPayload, encryptSecret } from "../src/crypto.js";
import worker from "../src/index.js";

const WORKSPACE = "workspace-1";
const IDENTITY = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const REQUEST_TOKEN = "r".repeat(64);
const INSTALLATION = "33333333-3333-4333-8333-333333333333";
const MASTER_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

function sessionHeaders(): HeadersInit {
  return {
    cookie: `ef_session=${IDENTITY}.${SESSION}`,
    "x-eventforge-request-token": REQUEST_TOKEN,
  };
}

function d1(handler: (sql: string, bindings: unknown[]) => unknown) {
  return {
    prepare(sql: string) {
      const record = { sql, bindings: [] as unknown[] };
      const stmt = {
        bind(...bindings: unknown[]) {
          record.bindings = bindings;
          return stmt;
        },
        first: async () => handler(record.sql, record.bindings),
        all: async () => {
          const value = handler(record.sql, record.bindings);
          return { results: Array.isArray(value) ? value : value ? [value] : [] };
        },
        run: async () => ({
          meta: { changes: handler(record.sql, record.bindings) === false ? 0 : 1 },
        }),
      };
      return stmt;
    },
    async batch(statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

function identityDb(
  role: "owner" | "admin" | "operator" | "viewer",
  extra?: (sql: string, bindings: unknown[]) => unknown,
) {
  return d1((sql, bindings) => {
    const override = extra?.(sql, bindings);
    if (override !== undefined) return override;
    if (sql.includes("from identities")) {
      return {
        id: IDENTITY,
        normalized_email: "ops@example.com",
        verified_at: "2026-01-01T00:00:00.000Z",
      };
    }
    if (sql.includes("from workspace_memberships")) {
      return [{ workspace_id: WORKSPACE, role, version: 1 }];
    }
    if (sql.includes("from workspaces")) return { id: WORKSPACE };
    return undefined;
  });
}

function authority() {
  return {
    getByName() {
      return {
        validate: async () => ({
          ok: true,
          session: {
            id: SESSION,
            requestToken: REQUEST_TOKEN,
            membershipVersion: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: "2026-01-01T00:00:00.000Z",
            userAgentLabel: "test",
            ipLabel: "unknown",
          },
          epoch: 1,
        }),
      };
    },
  };
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    ENVIRONMENT: "preview",
    PUBLIC_INGRESS_ENABLED: "false",
    DURABLE_DELIVERY_ENABLED: "false",
    MONITORING_ENABLED: "false",
    PAYLOAD_MASTER_KEY: MASTER_KEY,
    CONTROL_DB: identityDb("operator"),
    EVENTS_DB: d1(() => null),
    PAYLOADS: { put: vi.fn(), get: vi.fn(), delete: vi.fn(), head: vi.fn() },
    INGEST_QUEUE: { send: vi.fn() },
    IDENTITY_AUTHORITY: authority(),
    ...overrides,
  } as unknown as Env;
}

describe("hosted webhook v1 surface", () => {
  it("keeps unauthenticated /v1 probes AUTH_GATED", async () => {
    const gated = await worker.fetch(new Request("https://preview.example/v1/events"), env());
    expect(gated.status).toBe(503);
    await expect(gated.json()).resolves.toMatchObject({ code: "AUTH_GATED" });
    const workspace = await worker.fetch(
      new Request("https://preview.example/v1/workspaces/workspace-1/events", { method: "POST" }),
      env(),
    );
    expect(workspace.status).toBe(503);
    await expect(workspace.json()).resolves.toMatchObject({ code: "AUTH_GATED" });
  });

  it("rejects an invalid API key instead of pretending auth is disabled", async () => {
    const response = await worker.fetch(
      new Request("https://preview.example/v1/workspaces/workspace-1/events", {
        method: "POST",
        headers: { authorization: "Bearer efk_ffffffffffffffffffffffffffffffffffffffffffffffff" },
      }),
      env({
        CONTROL_DB: d1((sql) => {
          if (sql.includes("workspace_api_keys")) return null;
          return null;
        }),
      }),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("lets an operator create a destination under a workspace installation", async () => {
    const created: unknown[][] = [];
    const response = await worker.fetch(
      new Request(
        `https://preview.example/v1/workspaces/${WORKSPACE}/installations/${INSTALLATION}/destinations`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...sessionHeaders() },
          body: JSON.stringify({
            url: "https://hooks.example.com/webhook",
            eventTypes: ["invoice.paid"],
            maxRatePerSecond: 5,
          }),
        },
      ),
      env({
        CONTROL_DB: identityDb("operator", (sql, bindings) => {
          if (sql.includes("from delivery_installations")) {
            return {
              id: INSTALLATION,
              workspace_id: WORKSPACE,
              provider: "custom",
              installation_key: "route-1",
              status: "active",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
            };
          }
          if (sql.startsWith("insert into destination_endpoints")) {
            created.push(bindings);
            return 1;
          }
          if (sql.includes("from destination_endpoints")) {
            const bound = created[0];
            if (!bound) return null;
            return {
              id: bound[0],
              workspace_id: bound[1],
              installation_id: bound[2],
              url: bound[3],
              description: bound[4],
              secret_ciphertext: bound[5],
              secret_nonce: bound[6],
              previous_secret_ciphertext: null,
              previous_secret_nonce: null,
              secret_hint: bound[7],
              event_types: bound[8],
              channels: bound[9],
              max_rate_per_second: bound[10],
              mode: bound[11],
              status: bound[12],
              created_at: bound[13],
              updated_at: bound[14],
            };
          }
          if (sql.startsWith("insert into governance_audit_events")) return 1;
          return undefined;
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { url: string; secret: string; eventTypes: string[] };
    expect(body.url).toBe("https://hooks.example.com/webhook");
    expect(body.secret.startsWith("whsec_")).toBe(true);
    expect(body.eventTypes).toEqual(["invoice.paid"]);
    expect(created).toHaveLength(1);
  });

  it("does not let a viewer create destinations", async () => {
    const response = await worker.fetch(
      new Request(
        `https://preview.example/v1/workspaces/${WORKSPACE}/installations/${INSTALLATION}/destinations`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...sessionHeaders() },
          body: JSON.stringify({ url: "https://hooks.example.com/webhook" }),
        },
      ),
      env({ CONTROL_DB: identityDb("viewer") }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
  });

  it("stores a published event with no matching destination and returns 202", async () => {
    const put = vi.fn();
    const inserts: string[] = [];
    const response = await worker.fetch(
      new Request(`https://preview.example/v1/workspaces/${WORKSPACE}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "idem-1",
          ...sessionHeaders(),
        },
        body: JSON.stringify({
          installationId: INSTALLATION,
          eventType: "invoice.paid",
          payload: { id: 9 },
        }),
      }),
      env({
        CONTROL_DB: identityDb("operator", (sql) => {
          if (sql.includes("from delivery_installations")) {
            return {
              id: INSTALLATION,
              workspace_id: WORKSPACE,
              provider: "custom",
              installation_key: "route-1",
              status: "active",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
            };
          }
          if (sql.includes("from destination_endpoints")) return [];
          return undefined;
        }),
        EVENTS_DB: d1((sql) => {
          if (sql.includes("from publish_idempotency") && sql.startsWith("select")) return null;
          if (sql.includes("inbound_rate_counters") && sql.startsWith("select"))
            return { count: 1 };
          if (sql.startsWith("insert")) {
            inserts.push(sql);
            return 1;
          }
          return null;
        }),
        PAYLOADS: { put, get: vi.fn(), delete: vi.fn(), head: vi.fn() },
      }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      accepted: boolean;
      eventId: string;
      deliveryIds: string[];
      matchedDestinationCount: number;
    };
    expect(body.accepted).toBe(true);
    expect(body.deliveryIds).toEqual([]);
    expect(body.matchedDestinationCount).toBe(0);
    expect(put).toHaveBeenCalledOnce();
    expect(inserts.some((sql) => sql.includes("webhook_messages"))).toBe(true);
  });

  it("replays the first publish response for the same idempotency key", async () => {
    const stored = {
      request_hash: await (
        await import("../src/crypto.js")
      ).sha256(
        JSON.stringify({
          installationId: INSTALLATION,
          eventType: "invoice.paid",
          payload: { id: 9 },
        }),
      ),
      response_status: 202,
      response_body: JSON.stringify({
        accepted: true,
        duplicate: false,
        eventId: "evt-stored",
        deliveryIds: [],
        matchedDestinationCount: 0,
      }),
    };
    const response = await worker.fetch(
      new Request(`https://preview.example/v1/workspaces/${WORKSPACE}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "idem-1",
          ...sessionHeaders(),
        },
        body: JSON.stringify({
          installationId: INSTALLATION,
          eventType: "invoice.paid",
          payload: { id: 9 },
        }),
      }),
      env({
        EVENTS_DB: d1((sql) => {
          if (sql.includes("from publish_idempotency")) return stored;
          return null;
        }),
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ eventId: "evt-stored" });
  });

  it("requires a write grant before an API key can publish", async () => {
    const token = `efk_${"ab".repeat(24)}`;
    const keyHash = await hashToken(token);
    const response = await worker.fetch(
      new Request(`https://preview.example/v1/workspaces/${WORKSPACE}/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": "idem-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          installationId: INSTALLATION,
          eventType: "invoice.paid",
          payload: { id: 1 },
        }),
      }),
      env({
        CONTROL_DB: d1((sql) => {
          if (sql.includes("from workspace_api_keys") && sql.includes("key_hash")) {
            return {
              id: "key-1",
              workspace_id: WORKSPACE,
              events_permission: "none",
              destinations_permission: "none",
              deliveries_permission: "none",
              replay_permission: "none",
            };
          }
          if (sql.startsWith("update workspace_api_keys")) return 1;
          return null;
        }),
      }),
    );
    expect(keyHash).toHaveLength(64);
    expect(response.status).toBe(403);
  });

  it("lists delivery metadata without payloads and accepts an operator replay", async () => {
    const send = vi.fn();
    const list = await worker.fetch(
      new Request(`https://preview.example/v1/workspaces/${WORKSPACE}/deliveries?eventId=evt-1`, {
        headers: sessionHeaders(),
      }),
      env({
        EVENTS_DB: d1((sql) => {
          if (sql.includes("from deliveries") && sql.includes("order by")) {
            return [
              {
                id: "delivery-1",
                workspace_id: WORKSPACE,
                installation_id: INSTALLATION,
                destination_id: "dest-1",
                event_id: "evt-1",
                provider: "custom",
                status: "quarantined",
                safe_reason: "retry_exhausted",
                attempts_count: 8,
                correlation_id: "corr-1",
                payload_ref: "ref",
                payload_checksum: "sum",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
                completed_at: null,
                quarantined_at: "2026-01-01T00:00:00.000Z",
                next_retry_at: null,
              },
            ];
          }
          return null;
        }),
      }),
    );
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { items: Array<{ id: string; payloadRef?: string }> };
    expect(listed.items[0]?.id).toBe("delivery-1");
    expect(listed.items[0]?.payloadRef).toBeUndefined();

    const replay = await worker.fetch(
      new Request(
        `https://preview.example/v1/workspaces/${WORKSPACE}/deliveries/delivery-1/replay`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "replay-1",
            ...sessionHeaders(),
          },
          body: JSON.stringify({ reason: "endpoint recovered after timeout" }),
        },
      ),
      env({
        DURABLE_DELIVERY_ENABLED: "true",
        INGEST_QUEUE: { send },
        EVENTS_DB: d1((sql) => {
          if (sql.includes("from deliveries") && sql.includes("id = ?")) {
            return {
              id: "delivery-1",
              workspace_id: WORKSPACE,
              installation_id: INSTALLATION,
              destination_id: "dest-1",
              event_id: "evt-1",
              provider: "custom",
              status: "quarantined",
              safe_reason: "retry_exhausted",
              attempts_count: 8,
              correlation_id: "corr-1",
              payload_ref: "ref",
              payload_checksum: "sum",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              completed_at: null,
              quarantined_at: "2026-01-01T00:00:00.000Z",
              next_retry_at: null,
            };
          }
          if (sql.includes("from publish_idempotency")) return null;
          if (sql.startsWith("insert") || sql.startsWith("update")) return 1;
          return null;
        }),
      }),
    );
    expect(replay.status).toBe(202);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      operation: "replay",
      restoreStatus: "quarantined",
    });
    await expect(replay.json()).resolves.toMatchObject({
      replayed: true,
      deliveryId: "delivery-1",
    });
  });

  it("rejects replay of a leased delivery and stays gated while durable delivery is off", async () => {
    const processing = await worker.fetch(
      new Request(
        `https://preview.example/v1/workspaces/${WORKSPACE}/deliveries/delivery-1/replay`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...sessionHeaders() },
          body: JSON.stringify({ reason: "endpoint recovered after timeout" }),
        },
      ),
      env({
        DURABLE_DELIVERY_ENABLED: "true",
        EVENTS_DB: d1((sql) => {
          if (sql.includes("from deliveries") && sql.includes("id = ?")) {
            return {
              id: "delivery-1",
              workspace_id: WORKSPACE,
              installation_id: INSTALLATION,
              destination_id: "dest-1",
              event_id: "evt-1",
              provider: "custom",
              status: "processing",
              safe_reason: null,
              attempts_count: 1,
              correlation_id: "corr-1",
              payload_ref: "ref",
              payload_checksum: "sum",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              completed_at: null,
              quarantined_at: null,
              next_retry_at: null,
            };
          }
          return null;
        }),
      }),
    );
    expect(processing.status).toBe(409);

    const gated = await worker.fetch(
      new Request(
        `https://preview.example/v1/workspaces/${WORKSPACE}/deliveries/delivery-1/replay`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...sessionHeaders() },
          body: JSON.stringify({ reason: "endpoint recovered after timeout" }),
        },
      ),
      env({
        EVENTS_DB: d1((sql) => {
          if (sql.includes("from deliveries")) {
            return {
              id: "delivery-1",
              workspace_id: WORKSPACE,
              installation_id: INSTALLATION,
              destination_id: "dest-1",
              event_id: "evt-1",
              provider: "custom",
              status: "completed",
              safe_reason: null,
              attempts_count: 1,
              correlation_id: "corr-1",
              payload_ref: "ref",
              payload_checksum: "sum",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              completed_at: "2026-01-01T00:00:00.000Z",
              quarantined_at: null,
              next_retry_at: null,
            };
          }
          return null;
        }),
      }),
    );
    expect(gated.status).toBe(503);
    await expect(gated.json()).resolves.toMatchObject({ code: "DELIVERY_GATED" });
  });

  it("rejects replay without an attributable reason", async () => {
    const response = await worker.fetch(
      new Request(
        `https://preview.example/v1/workspaces/${WORKSPACE}/deliveries/delivery-1/replay`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...sessionHeaders() },
          body: JSON.stringify({ reason: "short" }),
        },
      ),
      env({
        DURABLE_DELIVERY_ENABLED: "true",
        EVENTS_DB: d1((sql) => {
          if (sql.includes("from deliveries") && sql.includes("id = ?")) {
            return {
              id: "delivery-1",
              workspace_id: WORKSPACE,
              installation_id: INSTALLATION,
              destination_id: "dest-1",
              event_id: "evt-1",
              provider: "custom",
              status: "quarantined",
              safe_reason: "retry_exhausted",
              attempts_count: 8,
              correlation_id: "corr-1",
              payload_ref: "ref",
              payload_checksum: "sum",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              completed_at: null,
              quarantined_at: "2026-01-01T00:00:00.000Z",
              next_retry_at: null,
            };
          }
          return null;
        }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_BODY" });
  });

  it("audits a denied payload reveal instead of returning the body", async () => {
    const audits: string[] = [];
    const response = await worker.fetch(
      new Request(
        `https://preview.example/v1/workspaces/${WORKSPACE}/deliveries/delivery-1/payload`,
        {
          headers: sessionHeaders(),
        },
      ),
      env({
        CONTROL_DB: identityDb("viewer", (sql) => {
          if (sql.startsWith("insert into governance_audit_events")) {
            audits.push(sql);
            return 1;
          }
          return undefined;
        }),
        EVENTS_DB: d1((sql) => {
          if (sql.includes("from deliveries") && sql.includes("id = ?")) {
            return {
              id: "delivery-1",
              workspace_id: WORKSPACE,
              installation_id: INSTALLATION,
              destination_id: "dest-1",
              event_id: "evt-1",
              provider: "custom",
              status: "completed",
              safe_reason: null,
              attempts_count: 1,
              correlation_id: "corr-1",
              payload_ref: "ref",
              payload_checksum: "sum",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              completed_at: "2026-01-01T00:00:00.000Z",
              quarantined_at: null,
              next_retry_at: null,
            };
          }
          if (sql.startsWith("insert into audit_entries")) {
            audits.push(sql);
            return 1;
          }
          return null;
        }),
      }),
    );
    expect(response.status).toBe(403);
    expect(audits.some((sql) => sql.includes("audit_entries"))).toBe(true);
    expect(audits.some((sql) => sql.includes("governance_audit_events"))).toBe(true);
  });

  it("lets an admin invite an address by writing identity and membership", async () => {
    const writes: string[] = [];
    const response = await worker.fetch(
      new Request(`https://preview.example/v1/workspaces/${WORKSPACE}/invitations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...sessionHeaders() },
        body: JSON.stringify({ email: "ops@example.net", role: "operator" }),
      }),
      env({
        CONTROL_DB: identityDb("admin", (sql) => {
          writes.push(sql);
          if (sql.includes("from identities") && sql.includes("where normalized_email"))
            return null;
          if (sql.includes("from workspace_memberships") && sql.includes("and identity_id = ?"))
            return null;
          if (sql.startsWith("insert")) return 1;
          return undefined;
        }),
      }),
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      email: "ops@example.net",
      role: "operator",
    });
    expect(writes.some((sql) => sql.includes("insert into identities"))).toBe(true);
    expect(writes.some((sql) => sql.includes("insert into workspace_memberships"))).toBe(true);
  });

  it("does not let an operator invite members", async () => {
    const response = await worker.fetch(
      new Request(`https://preview.example/v1/workspaces/${WORKSPACE}/invitations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...sessionHeaders() },
        body: JSON.stringify({ email: "ops@example.net", role: "viewer" }),
      }),
      env({ CONTROL_DB: identityDb("operator") }),
    );
    expect(response.status).toBe(403);
  });
});

describe("destination queue consumer", () => {
  it("does not POST destination deliveries while DURABLE_DELIVERY_ENABLED is off", async () => {
    const fetchImpl = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const ack = vi.fn();
    try {
      await worker.queue!(
        {
          messages: [
            {
              body: {
                deliveryId: "delivery-1",
                workspaceId: WORKSPACE,
                installationId: INSTALLATION,
                provider: "custom",
                correlationId: "corr-1",
                destinationId: "dest-1",
              },
              ack,
              retry: vi.fn(),
            },
          ],
        } as unknown as MessageBatch<{
          deliveryId: string;
          workspaceId: string;
          installationId: string;
          provider: string;
          correlationId: string;
          destinationId: string;
        }>,
        {
          CONTROL_DB: d1(() => ({ id: INSTALLATION, workspace_id: WORKSPACE, status: "active" })),
          EVENTS_DB: d1((sql) =>
            sql.startsWith("select attempts_count")
              ? {
                  attempts_count: 0,
                  first_attempt_at: null,
                  status: "queued",
                  payload_ref: "ref",
                  payload_checksum: "sum",
                  destination_id: "dest-1",
                }
              : null,
          ),
          PAYLOADS: { get: vi.fn(), head: vi.fn(), put: vi.fn(), delete: vi.fn() },
          DURABLE_DELIVERY_ENABLED: "false",
        } as unknown as Env,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
  });

  it("claims before consuming outbound rate and retries without leaving a lease", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const fetchImpl = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const updates: string[] = [];
    try {
      await worker.queue!(
        {
          messages: [
            {
              body: {
                deliveryId: "delivery-1",
                workspaceId: WORKSPACE,
                installationId: INSTALLATION,
                provider: "custom",
                correlationId: "corr-1",
                destinationId: "dest-1",
              },
              ack,
              retry,
            },
          ],
        } as unknown as MessageBatch<{
          deliveryId: string;
          workspaceId: string;
          installationId: string;
          provider: string;
          correlationId: string;
          destinationId: string;
        }>,
        {
          CONTROL_DB: d1((sql) => {
            if (sql.includes("from delivery_installations")) {
              return { id: INSTALLATION, workspace_id: WORKSPACE, status: "active" };
            }
            if (sql.includes("from destination_endpoints")) {
              return {
                id: "dest-1",
                workspace_id: WORKSPACE,
                installation_id: INSTALLATION,
                url: "https://hooks.example.com/webhook",
                description: "",
                secret_ciphertext: "x",
                secret_nonce: "y",
                previous_secret_ciphertext: null,
                previous_secret_nonce: null,
                secret_hint: "hint",
                event_types: "[]",
                channels: "[]",
                max_rate_per_second: 1,
                mode: "best_effort",
                status: "active",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
              };
            }
            return null;
          }),
          EVENTS_DB: d1((sql) => {
            if (sql.startsWith("select attempts_count")) {
              return {
                attempts_count: 0,
                first_attempt_at: null,
                status: "queued",
                payload_ref: "ref",
                payload_checksum: "sum",
                destination_id: "dest-1",
              };
            }
            if (sql.includes("outbound_rate_counters")) return false;
            if (sql.startsWith("update deliveries")) {
              updates.push(sql);
              return 1;
            }
            return 1;
          }),
          PAYLOADS: { get: vi.fn(), head: vi.fn(), put: vi.fn(), delete: vi.fn() },
          DURABLE_DELIVERY_ENABLED: "true",
        } as unknown as Env,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 1 });
    expect(updates.some((sql) => sql.includes("attempts_count = max(attempts_count - 1, 0)"))).toBe(
      true,
    );
    expect(
      updates.some((sql) =>
        sql.includes(
          "first_attempt_at = case when attempts_count <= 1 then null else first_attempt_at end",
        ),
      ),
    ).toBe(true);
  });

  it("POSTs a signed body for a destination delivery and completes the attempt", async () => {
    const secret = "whsec_REDACTED_SEE_1PASSWORD";
    const encryptedSecret = await encryptSecret(secret, MASTER_KEY);
    const payload = JSON.stringify({ hello: true });
    const bytes = new TextEncoder().encode(payload);
    const encrypted = await encryptPayload(bytes, MASTER_KEY);
    const checksum = "checksum";
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const ack = vi.fn();
    const retry = vi.fn();
    try {
      await worker.queue!(
        {
          messages: [
            {
              body: {
                deliveryId: "delivery-1",
                workspaceId: WORKSPACE,
                installationId: INSTALLATION,
                provider: "custom",
                correlationId: "corr-1",
                destinationId: "dest-1",
                eventId: "evt-1",
              },
              ack,
              retry,
            },
          ],
        } as unknown as MessageBatch<{
          deliveryId: string;
          workspaceId: string;
          installationId: string;
          provider: string;
          correlationId: string;
          destinationId: string;
          eventId: string;
        }>,
        {
          CONTROL_DB: d1((sql) => {
            if (sql.includes("from delivery_installations")) {
              return { id: INSTALLATION, workspace_id: WORKSPACE, status: "active" };
            }
            if (sql.includes("from destination_endpoints")) {
              return {
                id: "dest-1",
                workspace_id: WORKSPACE,
                installation_id: INSTALLATION,
                url: "https://hooks.example.com/webhook",
                description: "",
                secret_ciphertext: encryptedSecret.ciphertext,
                secret_nonce: encryptedSecret.nonce,
                previous_secret_ciphertext: null,
                previous_secret_nonce: null,
                secret_hint: "cret",
                event_types: "[]",
                channels: "[]",
                max_rate_per_second: 10,
                mode: "best_effort",
                status: "active",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
              };
            }
            return null;
          }),
          EVENTS_DB: d1((sql) => {
            if (sql.startsWith("select attempts_count")) {
              return {
                attempts_count: 0,
                first_attempt_at: null,
                status: "queued",
                payload_ref: "workspace-1/events/evt-1",
                payload_checksum: checksum,
                destination_id: "dest-1",
              };
            }
            if (sql.includes("outbound_rate_counters") && sql.startsWith("select"))
              return { count: 0 };
            if (
              sql.startsWith("update deliveries") ||
              sql.startsWith("insert") ||
              sql.startsWith("update")
            )
              return 1;
            return null;
          }),
          PAYLOADS: {
            get: vi.fn(async () => ({
              customMetadata: { nonce: encrypted.nonce, checksum },
              arrayBuffer: async () => encrypted.body,
            })),
            head: vi.fn(),
            put: vi.fn(),
            delete: vi.fn(),
          },
          PAYLOAD_MASTER_KEY: MASTER_KEY,
          DURABLE_DELIVERY_ENABLED: "true",
        } as unknown as Env,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get("webhook-id")).toBe("delivery-1");
    expect(headers.get("webhook-signature")).toMatch(/^v1,/);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("treats a failed replay as a single shot and restores the pre-replay status", async () => {
    const secret = "whsec_REDACTED_SEE_1PASSWORD";
    const encryptedSecret = await encryptSecret(secret, MASTER_KEY);
    const payload = JSON.stringify({ hello: true });
    const bytes = new TextEncoder().encode(payload);
    const encrypted = await encryptPayload(bytes, MASTER_KEY);
    const checksum = "checksum";
    const ack = vi.fn();
    const retry = vi.fn();
    const restored: unknown[][] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 400 })) as unknown as typeof fetch;
    try {
      await worker.queue!(
        {
          messages: [
            {
              body: {
                deliveryId: "delivery-1",
                workspaceId: WORKSPACE,
                installationId: INSTALLATION,
                provider: "custom",
                correlationId: "corr-1",
                destinationId: "dest-1",
                eventId: "evt-1",
                operation: "replay",
                restoreStatus: "completed",
              },
              ack,
              retry,
            },
          ],
        } as unknown as MessageBatch<{
          deliveryId: string;
          workspaceId: string;
          installationId: string;
          provider: string;
          correlationId: string;
          destinationId: string;
          eventId: string;
          operation: "replay";
          restoreStatus: "completed";
        }>,
        {
          CONTROL_DB: d1((sql) => {
            if (sql.includes("from delivery_installations")) {
              return { id: INSTALLATION, workspace_id: WORKSPACE, status: "active" };
            }
            if (sql.includes("from destination_endpoints")) {
              return {
                id: "dest-1",
                workspace_id: WORKSPACE,
                installation_id: INSTALLATION,
                url: "https://hooks.example.com/webhook",
                description: "",
                secret_ciphertext: encryptedSecret.ciphertext,
                secret_nonce: encryptedSecret.nonce,
                previous_secret_ciphertext: null,
                previous_secret_nonce: null,
                secret_hint: "cret",
                event_types: "[]",
                channels: "[]",
                max_rate_per_second: 10,
                mode: "best_effort",
                status: "active",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
              };
            }
            return null;
          }),
          EVENTS_DB: d1((sql, bindings) => {
            if (sql.startsWith("select attempts_count")) {
              return {
                attempts_count: 3,
                first_attempt_at: "2026-01-01T00:00:00.000Z",
                status: "completed",
                payload_ref: "workspace-1/events/evt-1",
                payload_checksum: checksum,
                destination_id: "dest-1",
              };
            }
            if (sql.includes("max(attempt_number)")) return { max_attempt: 3 };
            if (sql.startsWith("update deliveries set status = ?")) {
              restored.push(bindings);
              return 1;
            }
            if (
              sql.startsWith("update deliveries") ||
              sql.startsWith("insert") ||
              sql.startsWith("update")
            )
              return 1;
            return null;
          }),
          PAYLOADS: {
            get: vi.fn(async () => ({
              customMetadata: { nonce: encrypted.nonce, checksum },
              arrayBuffer: async () => encrypted.body,
            })),
            head: vi.fn(),
            put: vi.fn(),
            delete: vi.fn(),
          },
          PAYLOAD_MASTER_KEY: MASTER_KEY,
          DURABLE_DELIVERY_ENABLED: "true",
        } as unknown as Env,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(restored[0]?.[0]).toBe("completed");
  });
});
