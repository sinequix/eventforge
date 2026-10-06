import { describe, expect, it } from "vitest";
import {
  STANDARD_WEBHOOKS_TOLERANCE_SECONDS,
  WebhookVerificationError,
  decodeSigningSecret,
  generateSigningSecret,
  joinSignatures,
  signStandardWebhook,
  signatureFor,
  verifyStandardWebhook,
} from "../src/standard-webhooks.js";

describe("Standard Webhooks signatures", () => {
  const payload = JSON.stringify({ hello: "world" });

  it("signs with webhook-id, webhook-timestamp, and v1 base64 HMAC", async () => {
    const secret = generateSigningSecret();
    expect(secret.startsWith("whsec_")).toBe(true);
    const signed = await signStandardWebhook(payload, secret, {
      id: "msg_1",
      timestampSeconds: 1_700_000_000,
    });
    expect(signed.headers["webhook-id"]).toBe("msg_1");
    expect(signed.headers["webhook-timestamp"]).toBe("1700000000");
    expect(signed.headers["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/=]+$/);
    await expect(
      verifyStandardWebhook(payload, signed.headers, secret, { nowSeconds: 1_700_000_000 }),
    ).resolves.toEqual({ id: "msg_1", timestamp: 1_700_000_000 });
  });

  it("accepts either current or previous secret during rotation", async () => {
    const current = generateSigningSecret();
    const previous = generateSigningSecret();
    const signed = await signStandardWebhook(payload, [current, previous], {
      id: "delivery-1",
      timestampSeconds: 1_700_000_100,
    });
    expect(signed.headers["webhook-signature"].split(" ")).toHaveLength(2);
    await expect(
      verifyStandardWebhook(payload, signed.headers, current, { nowSeconds: 1_700_000_100 }),
    ).resolves.toMatchObject({ id: "delivery-1" });
    await expect(
      verifyStandardWebhook(payload, signed.headers, previous, { nowSeconds: 1_700_000_100 }),
    ).resolves.toMatchObject({ id: "delivery-1" });
    await expect(
      verifyStandardWebhook(payload, signed.headers, generateSigningSecret(), {
        nowSeconds: 1_700_000_100,
      }),
    ).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("rejects stale timestamps and missing headers", async () => {
    const secret = generateSigningSecret();
    const signed = await signStandardWebhook(payload, secret, {
      id: "msg_old",
      timestampSeconds: 1_000,
    });
    await expect(
      verifyStandardWebhook(payload, signed.headers, secret, {
        nowSeconds: 1_000 + STANDARD_WEBHOOKS_TOLERANCE_SECONDS + 1,
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(verifyStandardWebhook(payload, {}, secret)).rejects.toMatchObject({
      code: "missing_headers",
    });
    await expect(
      verifyStandardWebhook(
        payload,
        { "webhook-id": "x", "webhook-timestamp": "nope", "webhook-signature": "v1,abcd" },
        secret,
      ),
    ).rejects.toMatchObject({ code: "invalid_timestamp" });
  });

  it("does not accept a signature computed over a different body", async () => {
    const secret = generateSigningSecret();
    const signed = await signStandardWebhook(payload, secret, {
      id: "msg_2",
      timestampSeconds: 50,
    });
    await expect(
      verifyStandardWebhook("{}", signed.headers, secret, { nowSeconds: 50 }),
    ).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("accepts Headers, raw secrets, and rejects empty or versionless signatures", async () => {
    const secret = "not-prefixed-secret";
    const signed = await signStandardWebhook(payload, secret, {
      id: "msg_headers",
      timestampSeconds: 99,
    });
    const headers = new Headers(signed.headers);
    await expect(
      verifyStandardWebhook(payload, headers, secret, { nowSeconds: 99 }),
    ).resolves.toEqual({
      id: "msg_headers",
      timestamp: 99,
    });
    expect(decodeSigningSecret(secret).byteLength).toBeGreaterThan(0);
    expect(() => decodeSigningSecret("")).toThrow(WebhookVerificationError);
    expect(() => decodeSigningSecret("whsec_")).toThrow(WebhookVerificationError);
    await expect(
      verifyStandardWebhook(
        payload,
        { "webhook-id": "x", "webhook-timestamp": "99", "webhook-signature": "v2,abcd" },
        secret,
        { nowSeconds: 99 },
      ),
    ).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("joins rotation signatures with spaces", async () => {
    const first = await signatureFor("whsec_dGVzdA==", "id", 1, "{}");
    const second = await signatureFor("whsec_YWx0", "id", 1, "{}");
    expect(joinSignatures(first, second)).toBe(`${first} ${second}`);
    expect(joinSignatures(first, "")).toBe(first);
  });
});
