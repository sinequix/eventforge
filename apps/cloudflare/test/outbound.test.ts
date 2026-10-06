import { standardWebhooks } from "@eventforge/core";
import { describe, expect, it, vi } from "vitest";
import { postSignedWebhook } from "../src/outbound.js";

describe("signed outbound delivery", () => {
  const payload = JSON.stringify({ invoice: 12 });
  const secret = "whsec_REDACTED_SEE_1PASSWORD";

  it("POSTs Standard Webhooks headers and treats 2xx as success", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://hooks.example.com/webhook");
      const headers = new Headers(init?.headers);
      expect(headers.get("webhook-id")).toBe("delivery-1");
      expect(headers.get("webhook-timestamp")).toBe("1700000000");
      expect(headers.get("webhook-signature")).toMatch(/^v1,/);
      expect(init?.body).toBe(payload);
      expect(init?.redirect).toBe("manual");
      await expect(
        standardWebhooks.verifyStandardWebhook(payload, headers, secret, {
          nowSeconds: 1_700_000_000,
        }),
      ).resolves.toMatchObject({ id: "delivery-1" });
      return new Response(null, { status: 204 });
    });
    await expect(
      postSignedWebhook({
        url: "https://hooks.example.com/webhook",
        payload,
        deliveryId: "delivery-1",
        secrets: [secret],
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: new Date(1_700_000_000 * 1000),
      }),
    ).resolves.toMatchObject({ state: "success", status: 204 });
  });

  it("quarantines 4xx validation failures and retries 429 with Retry-After", async () => {
    await expect(
      postSignedWebhook({
        url: "https://hooks.example.com/webhook",
        payload,
        deliveryId: "delivery-1",
        secrets: [secret],
        fetchImpl: (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ state: "failure", reason: "validation_error", status: 400 });

    await expect(
      postSignedWebhook({
        url: "https://hooks.example.com/webhook",
        payload,
        deliveryId: "delivery-1",
        secrets: [secret],
        fetchImpl: (async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/" },
          })) as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ state: "failure", reason: "validation_error", status: 302 });

    await expect(
      postSignedWebhook({
        url: "https://hooks.example.com/webhook",
        payload,
        deliveryId: "delivery-1",
        secrets: [secret],
        fetchImpl: (async () =>
          new Response(null, {
            status: 429,
            headers: { "retry-after": "15" },
          })) as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({
      state: "failure",
      reason: "rate_limited",
      retryAfterSeconds: 15,
    });
  });

  it("maps timeouts onto the existing timeout reason", async () => {
    await expect(
      postSignedWebhook({
        url: "https://hooks.example.com/webhook",
        payload,
        deliveryId: "delivery-1",
        secrets: [secret],
        timeoutMs: 5,
        fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          const error = new Error("aborted");
          error.name = "AbortError";
          if (init?.signal?.aborted) throw error;
          await new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(error));
          });
          return new Response(null, { status: 200 });
        }) as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ state: "failure", reason: "timeout" });
  });
});
