import { standardWebhooks, webhookDestinations, type SafeDeliveryReason } from "@eventforge/core";
import { decryptPayload } from "./crypto.js";
import { destinationSecrets, type DestinationRow } from "./destinations.js";

const { signStandardWebhook } = standardWebhooks;
const { OUTBOUND_HTTP_TIMEOUT_MS, classifyDestinationResponse, parseRetryAfter } =
  webhookDestinations;

export type OutboundResult =
  | { state: "success"; status: number; latencyMs: number }
  | {
      state: "failure";
      reason: SafeDeliveryReason;
      status?: number;
      retryAfterSeconds?: number;
      latencyMs: number;
    };

export async function loadOutboundPayload(
  env: Env,
  payloadRef: string,
  checksum: string,
): Promise<string> {
  const object = await env.PAYLOADS.get(payloadRef);
  if (!object || !object.customMetadata?.nonce) {
    const error = new Error("payload_unavailable");
    throw error;
  }
  if (object.customMetadata.checksum !== checksum) {
    throw new Error("payload_corrupt");
  }
  try {
    const decrypted = await decryptPayload(
      await object.arrayBuffer(),
      env.PAYLOAD_MASTER_KEY,
      object.customMetadata.nonce,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error("payload_corrupt");
  }
}

export async function consumeOutboundRate(
  env: Env,
  destinationId: string,
  maxRatePerSecond: number,
  now = new Date(),
): Promise<boolean> {
  const windowStart = Math.floor(now.getTime() / 1000);
  const result = await env.EVENTS_DB.prepare(
    "insert into outbound_rate_counters (destination_id, window_start, count) values (?, ?, 1) on conflict(destination_id, window_start) do update set count = count + 1 where count < ?",
  )
    .bind(destinationId, windowStart, maxRatePerSecond)
    .run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function postSignedWebhook(input: {
  url: string;
  payload: string;
  deliveryId: string;
  secrets: readonly string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<OutboundResult> {
  const started = Date.now();
  const timestampSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const signed = await signStandardWebhook(input.payload, [...input.secrets], {
    id: input.deliveryId,
    timestampSeconds,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? OUTBOUND_HTTP_TIMEOUT_MS);
  try {
    const response = await (input.fetchImpl ?? fetch)(input.url, {
      method: "POST",
      body: input.payload,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "webhook-id": signed.headers["webhook-id"],
        "webhook-timestamp": signed.headers["webhook-timestamp"],
        "webhook-signature": signed.headers["webhook-signature"],
      },
    });
    const latencyMs = Date.now() - started;
    const classified = classifyDestinationResponse(response.status);
    if (classified === "success") return { state: "success", status: response.status, latencyMs };
    return {
      state: "failure",
      reason: classified,
      status: response.status,
      retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
      latencyMs,
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      state: "failure",
      reason: aborted ? "timeout" : "upstream_unavailable",
      latencyMs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function deliverDestinationAttempt(
  env: Env,
  destination: DestinationRow,
  input: { payloadRef: string; payloadChecksum: string; deliveryId: string },
  fetchImpl?: typeof fetch,
): Promise<OutboundResult> {
  const payload = await loadOutboundPayload(env, input.payloadRef, input.payloadChecksum);
  const secrets = await destinationSecrets(env, destination);
  return postSignedWebhook({
    url: destination.url,
    payload,
    deliveryId: input.deliveryId,
    secrets,
    fetchImpl,
  });
}
