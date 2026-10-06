import { describe, expect, it, vi } from "vitest";
import { EventForgeWebhooks, generateSigningSecret, sign, verify } from "../src/index.js";

describe("@eventforge/webhooks client", () => {
  it("publishes with an idempotency key and API key bearer token", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.eventforge.dev/v1/workspaces/ws-1/events");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer efk_abc");
      expect(headers.get("idempotency-key")).toBe("idem-1");
      return Response.json({
        accepted: true,
        duplicate: false,
        eventId: "evt-1",
        deliveryIds: ["del-1"],
        matchedDestinationCount: 1,
      });
    });
    const client = new EventForgeWebhooks({
      baseUrl: "https://api.eventforge.dev/",
      apiKey: "efk_abc",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.publish(
        "ws-1",
        { installationId: "inst-1", eventType: "invoice.paid", payload: { id: 1 } },
        { idempotencyKey: "idem-1" },
      ),
    ).resolves.toMatchObject({ eventId: "evt-1", deliveryIds: ["del-1"] });
  });

  it("replays a delivery and surfaces API errors", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("missing")) {
        return Response.json({ code: "NOT_FOUND", detail: "Route not found." }, { status: 404 });
      }
      return Response.json({
        accepted: true,
        replayed: true,
        deliveryId: "del-1",
        eventId: "evt-1",
      });
    });
    const client = new EventForgeWebhooks({
      baseUrl: "https://api.eventforge.dev",
      apiKey: "efk_abc",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.replay("ws-1", "del-1", { reason: "customer asked to replay", idempotencyKey: "r1" }),
    ).resolves.toEqual({
      accepted: true,
      replayed: true,
      deliveryId: "del-1",
      eventId: "evt-1",
    });
    await expect(
      client.replay("ws-1", "missing", { reason: "customer asked to replay" }),
    ).rejects.toThrow("Route not found.");
  });

  it("accepts a string idempotency key and falls back to global fetch", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        accepted: true,
        duplicate: false,
        eventId: "evt-2",
        deliveryIds: [],
        matchedDestinationCount: 0,
      }),
    );
    const previous = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const client = new EventForgeWebhooks({
        baseUrl: "https://api.eventforge.dev",
        apiKey: "efk_abc",
      });
      await expect(
        client.publish(
          "ws-1",
          { installationId: "inst-1", eventType: "invoice.paid", payload: {} },
          "idem-string",
        ),
      ).resolves.toMatchObject({ eventId: "evt-2" });
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("prefers problem detail, then code, then status when an API call fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ code: "FORBIDDEN" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({}, { status: 500 }));
    const client = new EventForgeWebhooks({
      baseUrl: "https://api.eventforge.dev",
      apiKey: "efk_abc",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.replay("ws-1", "del-2", { reason: "customer asked to replay" }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      client.replay("ws-1", "del-3", { reason: "customer asked to replay" }),
    ).rejects.toThrow("EventForge request failed (500)");
  });

  it("verifies Standard Webhooks signatures produced by sign()", async () => {
    const secret = generateSigningSecret();
    const payload = JSON.stringify({ ok: true });
    const signed = await sign(payload, secret, { id: "msg_9", timestampSeconds: 42 });
    await expect(verify(payload, signed.headers, secret, { nowSeconds: 42 })).resolves.toEqual({
      id: "msg_9",
      timestamp: 42,
    });
  });
});
