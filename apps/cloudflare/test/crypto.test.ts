import { describe, expect, it } from "vitest";
import {
  decryptPayload,
  encryptPayload,
  encryptSecret,
  decryptSecret,
  sha256,
  verifyHmac,
} from "../src/crypto.js";

describe("Workers crypto boundaries", () => {
  it("verifies a valid HMAC and rejects malformed signatures", async () => {
    const payload = new TextEncoder().encode("event");
    const secret = "test-secret";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, payload);
    const hex = [...new Uint8Array(signature)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await expect(verifyHmac(payload.buffer, `sha256=${hex}`, secret)).resolves.toBe(true);
    await expect(verifyHmac(payload.buffer, "invalid", secret)).resolves.toBe(false);
  });

  it("encrypts payloads with a unique nonce and stable checksum", async () => {
    const payload = new TextEncoder().encode("sensitive").buffer;
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const [first, second] = await Promise.all([
      encryptPayload(payload, key),
      encryptPayload(payload, key),
    ]);
    expect(first.nonce).not.toBe(second.nonce);
    await expect(sha256(payload)).resolves.toHaveLength(64);
    const decrypted = await decryptPayload(first.body, key, first.nonce);
    expect(new TextDecoder().decode(decrypted)).toBe("sensitive");
    const wrapped = await encryptSecret("whsec_test", key);
    await expect(decryptSecret(wrapped.ciphertext, wrapped.nonce, key)).resolves.toBe("whsec_test");
  });
});
