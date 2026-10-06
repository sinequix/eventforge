import { SafeDeliveryReason } from "@eventforge/core";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import worker, { reconcileDeliveries, safeReason } from "../src/index.js";

const messageBody = {
  deliveryId: "delivery-1",
  workspaceId: "workspace-1",
  installationId: "installation-1",
  provider: "custom",
  correlationId: "correlation-1",
};

function controlDatabase(status: "active" | "suspended" | "deleted" = "active") {
  return {
    prepare: () => ({
      bind() {
        return this;
      },
      first: async () => ({
        id: messageBody.installationId,
        workspace_id: messageBody.workspaceId,
        status,
      }),
    }),
  };
}

describe("durable delivery safety boundaries", () => {
  it("keeps database-safe reasons synchronized with the shared contract", () => {
    const migration = readFileSync(
      new URL("../migrations/events/0002_durable_deliveries.sql", import.meta.url),
      "utf8",
    );
    for (const reason of SafeDeliveryReason) expect(migration).toContain(`'${reason}'`);
  });

  it("quarantines unexpected failures instead of retrying an unknown error forever", () => {
    expect(safeReason(new Error("DATABASE_ERROR"))).toBe("internal_error");
    expect(safeReason(new Error("rate_limited"))).toBe("rate_limited");
  });

  it("quarantines a stale delivery whose durable payload is gone before requeueing it", async () => {
    const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
    const send = vi.fn();
    const eventDatabase = {
      prepare(sql: string) {
        const record = { sql, bindings: [] as unknown[] };
        prepared.push(record);
        return {
          bind(...bindings: unknown[]) {
            record.bindings = bindings;
            return this;
          },
          all: async () => ({
            results: [
              {
                id: messageBody.deliveryId,
                workspace_id: messageBody.workspaceId,
                installation_id: messageBody.installationId,
                provider: messageBody.provider,
                correlation_id: messageBody.correlationId,
                status: "queued",
                attempts_count: 0,
                first_attempt_at: null,
                payload_ref: "workspace-1/delivery-1",
                payload_checksum: "checksum",
              },
            ],
          }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch: async () => [{ meta: { changes: 1 } }],
    };

    const reconciled = await reconcileDeliveries({
      CONTROL_DB: controlDatabase(),
      EVENTS_DB: eventDatabase,
      PAYLOADS: { head: vi.fn().mockResolvedValue(null) },
      INGEST_QUEUE: { send },
    } as unknown as Env);

    expect(reconciled).toBe(1);
    expect(send).not.toHaveBeenCalled();
    const quarantine = prepared.find((statement) =>
      statement.sql.startsWith("update deliveries set status = 'quarantined'"),
    );
    expect(quarantine?.bindings[0]).toBe("payload_unavailable");
  });

  it("acks a duplicate queue message when another consumer already owns the lease", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const head = vi.fn();
    const eventDatabase = {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          first: async () =>
            sql.startsWith("select attempts_count")
              ? {
                  attempts_count: 0,
                  first_attempt_at: null,
                  status: "queued",
                  payload_ref: "workspace-1/delivery-1",
                  payload_checksum: "checksum",
                  destination_id: null,
                }
              : null,
          run: async () => ({ meta: { changes: 0 } }),
        };
      },
    };

    await worker.queue!(
      {
        messages: [{ body: messageBody, ack, retry }],
      } as unknown as MessageBatch<typeof messageBody>,
      {
        CONTROL_DB: controlDatabase(),
        EVENTS_DB: eventDatabase,
        PAYLOADS: { head },
      } as unknown as Env,
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
  });
});
