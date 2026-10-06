import { webhookDestinations } from "@eventforge/core";
import { type Access, actorId, canAccessResource, forbid } from "./access.js";
import { encryptPayload, sha256 } from "./crypto.js";
import { listActiveDestinations, loadInstallation } from "./destinations.js";
import { json, problem, readJson } from "./http.js";
import type { IngestMessage } from "./ingest.js";

const {
  INBOUND_BURST_PER_MINUTE,
  INBOUND_HOURLY_LIMIT,
  PUBLISH_PAYLOAD_MAX_BYTES,
  destinationMatches,
  hourWindowStart,
  minuteWindowStart,
  parseChannel,
  parseEventType,
} = webhookDestinations;

function durableDeliveryEnabled(env: Env): boolean {
  return String(env.DURABLE_DELIVERY_ENABLED) === "true";
}

export function publishIdempotencyKey(key: string): string {
  return `publish:${key}`;
}

const PENDING_FAILURE_BODY = JSON.stringify({
  type: "about:blank",
  title: "INTERNAL_ERROR",
  status: 500,
  code: "INTERNAL_ERROR",
  retryable: true,
  detail: "The request could not be completed.",
});

async function bumpRate(env: Env, bucketKey: string, windowStart: string): Promise<number> {
  await env.EVENTS_DB.prepare(
    "insert into inbound_rate_counters (bucket_key, window_start, count) values (?, ?, 1) on conflict(bucket_key, window_start) do update set count = count + 1",
  )
    .bind(bucketKey, windowStart)
    .run();
  const row = await env.EVENTS_DB.prepare(
    "select count from inbound_rate_counters where bucket_key = ? and window_start = ?",
  )
    .bind(bucketKey, windowStart)
    .first<{ count: number }>();
  return Number(row?.count ?? 1);
}

async function storedResponse(
  env: Env,
  workspaceId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<Response | undefined> {
  const row = await env.EVENTS_DB.prepare(
    "select request_hash, response_status, response_body from publish_idempotency where workspace_id = ? and idempotency_key = ?",
  )
    .bind(workspaceId, idempotencyKey)
    .first<{ request_hash: string; response_status: number; response_body: string }>();
  if (!row) return undefined;
  if (row.request_hash !== requestHash)
    return problem(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key was reused with a different request body.",
    );
  return json(JSON.parse(row.response_body) as unknown, row.response_status);
}

export async function handlePublish(
  request: Request,
  env: Env,
  access: Access,
  workspaceId: string,
  rest: string,
): Promise<Response | undefined> {
  if (rest !== "events") return undefined;
  if (request.method !== "POST")
    return problem(405, "METHOD_NOT_ALLOWED", "Use POST to publish events.", undefined, {
      allow: "POST",
    });
  if (!canAccessResource(access, workspaceId, "events", "write")) return forbid("events", "write");

  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey)
    return problem(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.");
  if (idempotencyKey.length > 256)
    return problem(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key is too long.");

  const body = await readJson(request, PUBLISH_PAYLOAD_MAX_BYTES);
  if (!body.ok) return body.response;
  const payload = (body.value ?? {}) as Record<string, unknown>;
  const requestHash = await sha256(body.raw);
  const storedKey = publishIdempotencyKey(idempotencyKey);
  const replayed = await storedResponse(env, workspaceId, storedKey, requestHash);
  if (replayed) return replayed;

  const installationId = typeof payload.installationId === "string" ? payload.installationId : "";
  const installation = installationId
    ? await loadInstallation(env, workspaceId, installationId)
    : undefined;
  if (!installation || installation.status === "deleted")
    return problem(404, "NOT_FOUND", "Installation was not found in this workspace.");
  if (installation.status !== "active")
    return problem(403, "WORKSPACE_INACTIVE", "Installation is not active.");

  let eventType: string;
  let channel: string | undefined;
  if (
    typeof payload.payload !== "object" ||
    payload.payload === null ||
    Array.isArray(payload.payload)
  )
    return problem(400, "INVALID_BODY", "payload must be a JSON object.");
  try {
    eventType = parseEventType(payload.eventType);
    channel = parseChannel(payload.channel);
  } catch (error) {
    return problem(400, "INVALID_BODY", error instanceof Error ? error.message : "Invalid event.");
  }

  const now = new Date();
  const callerKey =
    access.kind === "session" ? `identity:${access.identityId}` : `key:${access.keyId}`;
  const hourly = await bumpRate(env, `${callerKey}:hour`, hourWindowStart(now));
  if (hourly > INBOUND_HOURLY_LIMIT)
    return problem(429, "RATE_LIMITED", "Hourly publish budget exceeded.", undefined, {
      "retry-after": "3600",
    });
  const burst = await bumpRate(
    env,
    `installation:${installation.id}:minute`,
    minuteWindowStart(now),
  );
  if (burst > INBOUND_BURST_PER_MINUTE)
    return problem(429, "RATE_LIMITED", "Publish burst limit exceeded.", undefined, {
      "retry-after": "60",
    });

  const payloadText = JSON.stringify(payload.payload);
  const payloadBytes = new TextEncoder().encode(payloadText);
  if (payloadBytes.byteLength > PUBLISH_PAYLOAD_MAX_BYTES)
    return problem(413, "PAYLOAD_TOO_LARGE", "Event payload is too large.");

  const reservedAt = now.toISOString();
  try {
    await env.EVENTS_DB.prepare(
      "insert into publish_idempotency (workspace_id,idempotency_key,request_hash,response_status,response_body,created_at) values (?,?,?,?,?,?)",
    )
      .bind(workspaceId, storedKey, requestHash, 500, PENDING_FAILURE_BODY, reservedAt)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/unique|constraint/i.test(message)) {
      const existing = await storedResponse(env, workspaceId, storedKey, requestHash);
      if (existing) return existing;
      return problem(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key was reused with a different request body.",
      );
    }
    throw error;
  }

  const destinations = (await listActiveDestinations(env, workspaceId, installation.id)).filter(
    (destination) =>
      destinationMatches(
        {
          eventTypes: JSON.parse(destination.event_types) as string[],
          channels: JSON.parse(destination.channels) as string[],
        },
        { eventType, channel },
      ),
  );

  const eventId = crypto.randomUUID();
  const checksum = await sha256(payloadBytes);
  const payloadRef = `${workspaceId}/events/${eventId}`;
  const encrypted = await encryptPayload(payloadBytes, env.PAYLOAD_MASTER_KEY);
  await env.PAYLOADS.put(payloadRef, encrypted.body, {
    customMetadata: { nonce: encrypted.nonce, checksum },
  });

  const timestamp = now.toISOString();
  const correlationId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    env.EVENTS_DB.prepare(
      "insert into webhook_messages (id,workspace_id,installation_id,event_type,channel,idempotency_key,payload_ref,payload_checksum,payload_bytes,matched_destination_count,status,created_at) values (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      eventId,
      workspaceId,
      installation.id,
      eventType,
      channel ?? null,
      idempotencyKey,
      payloadRef,
      checksum,
      payloadBytes.byteLength,
      destinations.length,
      destinations.length === 0 ? "no_match" : durableDeliveryEnabled(env) ? "enqueued" : "stored",
      timestamp,
    ),
  ];

  const deliveryIds: string[] = [];
  const outboxIds: string[] = [];
  const enqueue = durableDeliveryEnabled(env);
  for (const destination of destinations) {
    const deliveryId = crypto.randomUUID();
    deliveryIds.push(deliveryId);
    const message: IngestMessage = {
      deliveryId,
      workspaceId,
      installationId: installation.id,
      provider: installation.provider,
      correlationId,
      destinationId: destination.id,
      eventId,
      operation: "process",
    };
    statements.push(
      env.EVENTS_DB.prepare(
        "insert into deliveries (id,workspace_id,installation_id,provider,provider_delivery_id,payload_ref,payload_checksum,status,correlation_id,created_at,updated_at,destination_id,event_id) values (?,?,?,?,?,?,?,'accepted',?,?,?,?,?)",
      ).bind(
        deliveryId,
        workspaceId,
        installation.id,
        installation.provider,
        `${eventId}:${destination.id}`,
        payloadRef,
        checksum,
        correlationId,
        timestamp,
        timestamp,
        destination.id,
        eventId,
      ),
    );
    if (enqueue) {
      const outboxId = crypto.randomUUID();
      outboxIds.push(outboxId);
      statements.push(
        env.EVENTS_DB.prepare(
          "insert into outbox (id,workspace_id,operation,idempotency_key,payload,created_at) values (?,?,?,?,?,?)",
        ).bind(
          outboxId,
          workspaceId,
          "ingest",
          `destination:${deliveryId}`,
          JSON.stringify(message),
          timestamp,
        ),
      );
    }
  }

  statements.push(
    env.EVENTS_DB.prepare(
      "insert into audit_entries (id,workspace_id,kind,subject_id,message,created_at) values (?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      workspaceId,
      "event_published",
      eventId,
      `published by ${actorId(access)}; matched ${destinations.length} destination(s)`,
      timestamp,
    ),
  );

  const responseBody = {
    accepted: true,
    duplicate: false,
    eventId,
    deliveryIds,
    matchedDestinationCount: destinations.length,
  };
  statements.push(
    env.EVENTS_DB.prepare(
      "update publish_idempotency set response_status = 202, response_body = ? where workspace_id = ? and idempotency_key = ?",
    ).bind(JSON.stringify(responseBody), workspaceId, storedKey),
  );
  try {
    await env.EVENTS_DB.batch(statements);
  } catch (error) {
    await env.PAYLOADS.delete(payloadRef);
    const message = error instanceof Error ? error.message : "";
    if (/unique|constraint/i.test(message)) {
      const existing = await storedResponse(env, workspaceId, storedKey, requestHash);
      if (existing) return existing;
      return problem(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key was reused with a different request body.",
      );
    }
    throw error;
  }

  if (enqueue && outboxIds.length > 0) {
    try {
      const placeholders = outboxIds.map(() => "?").join(",");
      const pending = await env.EVENTS_DB.prepare(
        `select id, payload from outbox where id in (${placeholders}) and published_at is null`,
      )
        .bind(...outboxIds)
        .all<{ id: string; payload: string }>();
      for (const row of pending.results ?? []) {
        const message = JSON.parse(row.payload) as IngestMessage;
        await env.INGEST_QUEUE.send(message);
        const publishedAt = new Date().toISOString();
        await env.EVENTS_DB.batch([
          env.EVENTS_DB.prepare(
            "update outbox set published_at = ? where id = ? and published_at is null",
          ).bind(publishedAt, row.id),
          env.EVENTS_DB.prepare(
            "update deliveries set status = 'queued', updated_at = ? where id = ? and status = 'accepted'",
          ).bind(publishedAt, message.deliveryId),
        ]);
      }
    } catch {
      console.error(
        JSON.stringify({
          event: "delivery_queue_publish_deferred",
          eventId,
          workspaceId,
        }),
      );
    }
  }

  return json(responseBody, 202);
}
