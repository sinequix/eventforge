const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as BufferSource;
}

export async function sha256(value: BufferSource | string): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

export async function verifyHmac(
  payload: ArrayBuffer,
  received: string,
  secret: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const normalized = received.startsWith("sha256=") ? received.slice(7) : received;
  if (!/^[a-f0-9]{64}$/i.test(normalized)) return false;
  const signature = Uint8Array.from(normalized.match(/.{2}/g) ?? [], (part) =>
    Number.parseInt(part, 16),
  );
  return crypto.subtle.verify("HMAC", key, signature, payload);
}

function aesKeyBytes(base64Key: string): Uint8Array {
  const rawKey = Uint8Array.from(atob(base64Key), (character) => character.charCodeAt(0));
  if (rawKey.byteLength !== 32) throw new Error("Payload master key must decode to 32 bytes.");
  return rawKey;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function encryptPayload(
  payload: BufferSource,
  base64Key: string,
): Promise<{ body: ArrayBuffer; nonce: string }> {
  const key = await crypto.subtle.importKey(
    "raw",
    asBufferSource(aesKeyBytes(base64Key)),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  return {
    body: await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, payload),
    nonce: btoa(String.fromCharCode(...nonce)),
  };
}

export async function decryptPayload(
  body: BufferSource,
  base64Key: string,
  base64Nonce: string,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    asBufferSource(aesKeyBytes(base64Key)),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const nonce = Uint8Array.from(atob(base64Nonce), (character) => character.charCodeAt(0));
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: asBufferSource(nonce) }, key, body);
}

export async function encryptSecret(
  secret: string,
  base64Key: string,
): Promise<{ ciphertext: string; nonce: string }> {
  const encrypted = await encryptPayload(new TextEncoder().encode(secret), base64Key);
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted.body)), nonce: encrypted.nonce };
}

export async function decryptSecret(
  ciphertext: string,
  nonce: string,
  base64Key: string,
): Promise<string> {
  const bytes = await decryptPayload(asBufferSource(base64ToBytes(ciphertext)), base64Key, nonce);
  return new TextDecoder().decode(bytes);
}
