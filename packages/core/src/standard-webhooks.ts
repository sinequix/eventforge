/** Standard Webhooks signing for EventForge → subscriber POSTs. */
export const WEBHOOK_ID_HEADER = "webhook-id";
export const WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "webhook-signature";
export const STANDARD_WEBHOOKS_TOLERANCE_SECONDS = 300;
const SECRET_PREFIX = "whsec_";
const SIGNATURE_VERSION = "v1";

export type StandardWebhookHeaders = {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
};

export class WebhookVerificationError extends Error {
  constructor(
    readonly code:
      | "missing_headers"
      | "invalid_timestamp"
      | "timestamp_expired"
      | "invalid_signature"
      | "invalid_secret",
    message: string,
  ) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): number {
  const length = Math.max(left.length, right.length, 1);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1)
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return mismatch === 0 ? 1 : 0;
}

export function decodeSigningSecret(secret: string): Uint8Array {
  if (!secret) throw new WebhookVerificationError("invalid_secret", "Signing secret is required.");
  if (secret.startsWith(SECRET_PREFIX)) {
    const encoded = secret.slice(SECRET_PREFIX.length);
    if (!encoded)
      throw new WebhookVerificationError("invalid_secret", "Signing secret is required.");
    return base64ToBytes(encoded);
  }
  return new TextEncoder().encode(secret);
}

export function generateSigningSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${SECRET_PREFIX}${bytesToBase64(bytes)}`;
}

export function signedContent(id: string, timestampSeconds: number, payload: string): string {
  return `${id}.${timestampSeconds}.${payload}`;
}

async function hmacSha256(secret: Uint8Array, content: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content) as BufferSource),
  );
}

export async function signatureFor(
  secret: string,
  id: string,
  timestampSeconds: number,
  payload: string,
): Promise<string> {
  const digest = await hmacSha256(
    decodeSigningSecret(secret),
    signedContent(id, timestampSeconds, payload),
  );
  return `${SIGNATURE_VERSION},${bytesToBase64(digest)}`;
}

/** Space-delimited signatures so current + previous secrets both verify during rotation. */
export function joinSignatures(...signatures: string[]): string {
  return signatures.filter(Boolean).join(" ");
}

export async function signStandardWebhook(
  payload: string,
  secret: string | readonly string[],
  options: { id?: string; timestampSeconds?: number } = {},
): Promise<{ id: string; timestamp: number; headers: StandardWebhookHeaders }> {
  const id = options.id ?? crypto.randomUUID();
  const timestamp = options.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const secrets = Array.isArray(secret) ? secret : [secret];
  const signatures = await Promise.all(
    secrets.map((value) => signatureFor(value, id, timestamp, payload)),
  );
  return {
    id,
    timestamp,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": joinSignatures(...signatures),
    },
  };
}

function headerValue(
  headers: Headers | Record<string, string | undefined | null>,
  name: string,
): string | undefined {
  if (headers instanceof Headers)
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  const record = headers as Record<string, string | undefined | null>;
  return (
    record[name] ??
    record[name.toLowerCase()] ??
    record[name.replaceAll("-", "_")] ??
    undefined
  )?.trim();
}

function parseSignatures(header: string): Uint8Array[] {
  const versions: Uint8Array[] = [];
  for (const part of header.trim().split(/\s+/)) {
    const separator = part.indexOf(",");
    if (separator <= 0) continue;
    const version = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (version !== SIGNATURE_VERSION || !value) continue;
    try {
      versions.push(base64ToBytes(value));
    } catch {
      continue;
    }
  }
  return versions;
}

export async function verifyStandardWebhook(
  payload: string,
  headers: Headers | Record<string, string | undefined | null>,
  secret: string | readonly string[],
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): Promise<{ id: string; timestamp: number }> {
  const id = headerValue(headers, WEBHOOK_ID_HEADER);
  const timestampHeader = headerValue(headers, WEBHOOK_TIMESTAMP_HEADER);
  const signatureHeader = headerValue(headers, WEBHOOK_SIGNATURE_HEADER);
  if (!id || !timestampHeader || !signatureHeader) {
    throw new WebhookVerificationError(
      "missing_headers",
      "webhook-id, webhook-timestamp, and webhook-signature are required.",
    );
  }
  if (!/^[0-9]+$/.test(timestampHeader)) {
    throw new WebhookVerificationError(
      "invalid_timestamp",
      "webhook-timestamp must be unix seconds.",
    );
  }
  const timestamp = Number(timestampHeader);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? STANDARD_WEBHOOKS_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    throw new WebhookVerificationError(
      "timestamp_expired",
      "webhook-timestamp is outside the allowed tolerance.",
    );
  }
  const provided = parseSignatures(signatureHeader);
  if (provided.length === 0) {
    throw new WebhookVerificationError(
      "invalid_signature",
      "No v1 webhook signature was provided.",
    );
  }
  const secrets = Array.isArray(secret) ? secret : [secret];
  const expected: Uint8Array[] = [];
  for (const value of secrets) {
    expected.push(
      await hmacSha256(decodeSigningSecret(value), signedContent(id, timestamp, payload)),
    );
  }
  let matched = 0;
  for (const signature of provided) {
    for (const candidate of expected) matched |= timingSafeEqual(signature, candidate);
  }
  if (matched) return { id, timestamp };
  throw new WebhookVerificationError("invalid_signature", "Webhook signature verification failed.");
}
