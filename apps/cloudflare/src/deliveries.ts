import { type Access, actorId, canAccessResource, forbid } from "./access.js";
import { decryptPayload, sha256 } from "./crypto.js";
import { json, problem, readJson } from "./http.js";
import type { DeliveryRestoreStatus, IngestMessage } from "./ingest.js";

const REPLAYABLE = new Set(["quarantined", "completed", "retrying"]);

type DeliveryRow = {
  id: string;
  workspace_id: string;
  installation_id: string;
  destination_id: string | null;
  event_id: string | null;
  provider: string;
  status: string;
  safe_reason: string | null;
  attempts_count: number;
  correlation_id: string;
  payload_ref: string;
  payload_checksum: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  quarantined_at: string | null;
  next_retry_at: string | null;
};

export function parseReplayReason(value: unknown): string {
  if (typeof value !== "string") throw new Error("Replay requires a reason.");
  const reason = value.trim();
  if (reason.length < 8 || reason.length > 500)
    throw new Error("Replay reason must be between 8 and 500 characters.");
  for (let index = 0; index < reason.length; index += 1) {
    const code = reason.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13)
      throw new Error("Replay reason contains invalid characters.");
  }
  return reason;
}

async function recordSensitiveAccess(
  env: Env,
  access: Access,
  workspaceId: string,
  kind: string,
  subjectId: string,
  metadata: Record<string, string>,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const message = `${kind} by ${actorId(access)}`;
  await env.EVENTS_DB.prepare(
    "insert into audit_entries (id,workspace_id,kind,subject_id,message,created_at) values (?,?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), workspaceId, kind, subjectId, message, timestamp)
    .run();
  if (access.kind !== "session") return;
  await env.CONTROL_DB.prepare(
    "insert into governance_audit_events (id,workspace_id,actor_identity_id,session_id,kind,subject_id,metadata,created_at) values (?,?,?,?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      workspaceId,
      access.identityId,
      access.sessionId,
      kind,
      subjectId,
      JSON.stringify(metadata),
      timestamp,
    )
    .run();
}

function publicDelivery(row: DeliveryRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    installationId: row.installation_id,
    destinationId: row.destination_id,
    eventId: row.event_id,
    provider: row.provider,
    status: row.status,
    safeReason: row.safe_reason,
    attemptsCount: row.attempts_count,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    quarantinedAt: row.quarantined_at,
    nextRetryAt: row.next_retry_at,
  };
}

async function loadDelivery(
  env: Env,
  workspaceId: string,
  deliveryId: string,
): Promise<DeliveryRow | undefined> {
  return (
    (await env.EVENTS_DB.prepare(
      "select id,workspace_id,installation_id,destination_id,event_id,provider,status,safe_reason,attempts_count,correlation_id,payload_ref,payload_checksum,created_at,updated_at,completed_at,quarantined_at,next_retry_at from deliveries where id = ? and workspace_id = ?",
    )
      .bind(deliveryId, workspaceId)
      .first<DeliveryRow>()) ?? undefined
  );
}

export async function handleLogs(
  request: Request,
  env: Env,
  access: Access,
  workspaceId: string,
  rest: string,
  url: URL,
): Promise<Response | undefined> {
  if (rest === "deliveries" && request.method === "GET") {
    if (!canAccessResource(access, workspaceId, "deliveries", "read"))
      return forbid("deliveries", "read");
    const eventId = url.searchParams.get("eventId");
    const status = url.searchParams.get("status");
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
    let sql =
      "select id,workspace_id,installation_id,destination_id,event_id,provider,status,safe_reason,attempts_count,correlation_id,payload_ref,payload_checksum,created_at,updated_at,completed_at,quarantined_at,next_retry_at from deliveries where workspace_id = ?";
    const bindings: unknown[] = [workspaceId];
    if (eventId) {
      sql += " and event_id = ?";
      bindings.push(eventId);
    }
    if (status) {
      sql += " and status = ?";
      bindings.push(status);
    }
    sql += " order by created_at desc limit ?";
    bindings.push(limit);
    const { results } = await env.EVENTS_DB.prepare(sql)
      .bind(...bindings)
      .all<DeliveryRow>();
    return json({ items: (results ?? []).map(publicDelivery) });
  }

  const eventMatch = /^events\/([^/]+)$/.exec(rest);
  if (eventMatch && request.method === "GET") {
    if (!canAccessResource(access, workspaceId, "events", "read")) return forbid("events", "read");
    const row = await env.EVENTS_DB.prepare(
      "select id,workspace_id,installation_id,event_type,channel,idempotency_key,payload_bytes,matched_destination_count,status,created_at from webhook_messages where id = ? and workspace_id = ?",
    )
      .bind(eventMatch[1], workspaceId)
      .first<{
        id: string;
        workspace_id: string;
        installation_id: string;
        event_type: string;
        channel: string | null;
        idempotency_key: string;
        payload_bytes: number;
        matched_destination_count: number;
        status: string;
        created_at: string;
      }>();
    if (!row) return problem(404, "NOT_FOUND", "Route not found.");
    return json({
      id: row.id,
      workspaceId: row.workspace_id,
      installationId: row.installation_id,
      eventType: row.event_type,
      channel: row.channel,
      payloadBytes: row.payload_bytes,
      matchedDestinationCount: row.matched_destination_count,
      status: row.status,
      createdAt: row.created_at,
    });
  }

  const deliveryMatch = /^deliveries\/([^/]+)(?:\/(attempts|payload|replay))?$/.exec(rest);
  if (!deliveryMatch) return undefined;
  const delivery = await loadDelivery(env, workspaceId, deliveryMatch[1]!);
  if (!delivery) return problem(404, "NOT_FOUND", "Route not found.");
  const suffix = deliveryMatch[2];

  if (!suffix && request.method === "GET") {
    if (!canAccessResource(access, workspaceId, "deliveries", "read"))
      return forbid("deliveries", "read");
    return json(publicDelivery(delivery));
  }

  if (suffix === "attempts" && request.method === "GET") {
    if (!canAccessResource(access, workspaceId, "deliveries", "read"))
      return forbid("deliveries", "read");
    const { results } = await env.EVENTS_DB.prepare(
      "select id,delivery_id,attempt_number,operation,status,safe_reason,billing_effect,response_code,latency_ms,started_at,finished_at from delivery_attempts where workspace_id = ? and delivery_id = ? order by attempt_number",
    )
      .bind(workspaceId, delivery.id)
      .all<{
        id: string;
        delivery_id: string;
        attempt_number: number;
        operation: string;
        status: string;
        safe_reason: string | null;
        billing_effect: string;
        response_code: number | null;
        latency_ms: number | null;
        started_at: string;
        finished_at: string | null;
      }>();
    return json({
      items: (results ?? []).map((row) => ({
        id: row.id,
        deliveryId: row.delivery_id,
        attemptNumber: row.attempt_number,
        operation: row.operation,
        status: row.status,
        safeReason: row.safe_reason,
        billingEffect: row.billing_effect,
        responseCode: row.response_code,
        latencyMs: row.latency_ms,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      })),
    });
  }

  if (suffix === "payload" && request.method === "GET") {
    const allowed = canAccessResource(access, workspaceId, "deliveries", "write");
    try {
      await recordSensitiveAccess(
        env,
        access,
        workspaceId,
        allowed ? "payload_revealed" : "payload_reveal_denied",
        delivery.id,
        { actor: actorId(access), outcome: allowed ? "allowed" : "denied" },
      );
    } catch {
      return problem(503, "AUDIT_UNAVAILABLE", "Sensitive access could not be recorded.");
    }
    if (!allowed) return forbid("deliveries", "write");
    const object = await env.PAYLOADS.get(delivery.payload_ref);
    if (!object || !object.customMetadata?.nonce)
      return problem(404, "PAYLOAD_UNAVAILABLE", "Payload is no longer available.");
    if (object.customMetadata.checksum !== delivery.payload_checksum)
      return problem(409, "PAYLOAD_CORRUPT", "Stored payload checksum does not match.");
    try {
      const decrypted = await decryptPayload(
        await object.arrayBuffer(),
        env.PAYLOAD_MASTER_KEY,
        object.customMetadata.nonce,
      );
      return new Response(decrypted, {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } catch {
      return problem(409, "PAYLOAD_CORRUPT", "Stored payload could not be decrypted.");
    }
  }

  if (suffix === "replay" && request.method === "POST") {
    const allowed = canAccessResource(access, workspaceId, "replay", "write");
    if (!allowed) {
      try {
        await recordSensitiveAccess(env, access, workspaceId, "replay_denied", delivery.id, {
          actor: actorId(access),
          outcome: "denied",
        });
      } catch {
        return problem(503, "AUDIT_UNAVAILABLE", "Sensitive access could not be recorded.");
      }
      return forbid("replay", "write");
    }
    const body = await readJson(request, 8192);
    if (!body.ok) return body.response;
    let reason: string;
    try {
      reason = parseReplayReason((body.value as { reason?: unknown } | null)?.reason);
    } catch (error) {
      return problem(
        400,
        "INVALID_BODY",
        error instanceof Error ? error.message : "Replay requires a reason.",
      );
    }
    if (String(env.DURABLE_DELIVERY_ENABLED) !== "true")
      return problem(503, "DELIVERY_GATED", "Durable delivery release gates have not passed.");
    if (delivery.status === "processing")
      return problem(409, "CONFLICT", "Delivery is currently leased for an in-flight attempt.");
    if (!REPLAYABLE.has(delivery.status))
      return problem(409, "CONFLICT", "Delivery is already in the pipeline.");
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    const requestHash = await sha256(body.raw);
    if (idempotencyKey) {
      const existing = await env.EVENTS_DB.prepare(
        "select request_hash, response_status, response_body from publish_idempotency where workspace_id = ? and idempotency_key = ?",
      )
        .bind(workspaceId, `replay:${delivery.id}:${idempotencyKey}`)
        .first<{ request_hash: string; response_status: number; response_body: string }>();
      if (existing) {
        if (existing.request_hash !== requestHash)
          return problem(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key was reused with a different request body.",
          );
        return json(JSON.parse(existing.response_body) as unknown, existing.response_status);
      }
    }
    const now = new Date();
    const timestamp = now.toISOString();
    const message: IngestMessage = {
      deliveryId: delivery.id,
      workspaceId,
      installationId: delivery.installation_id,
      provider: delivery.provider,
      correlationId: delivery.correlation_id,
      destinationId: delivery.destination_id ?? undefined,
      eventId: delivery.event_id ?? undefined,
      operation: "replay",
      restoreStatus: delivery.status as DeliveryRestoreStatus,
    };
    const responseBody = {
      accepted: true,
      replayed: true,
      deliveryId: delivery.id,
      eventId: delivery.event_id,
    };
    const outboxId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      env.EVENTS_DB.prepare(
        "insert into outbox (id,workspace_id,operation,idempotency_key,payload,created_at) values (?,?,?,?,?,?)",
      ).bind(
        outboxId,
        workspaceId,
        "replay",
        `replay:${delivery.id}:${timestamp}`,
        JSON.stringify(message),
        timestamp,
      ),
      env.EVENTS_DB.prepare(
        "insert into audit_entries (id,workspace_id,kind,subject_id,message,created_at) values (?,?,?,?,?,?)",
      ).bind(
        crypto.randomUUID(),
        workspaceId,
        "delivery_replayed",
        delivery.id,
        `replay requested by ${actorId(access)}: ${reason}`,
        timestamp,
      ),
    ];
    if (idempotencyKey) {
      statements.push(
        env.EVENTS_DB.prepare(
          "insert into publish_idempotency (workspace_id,idempotency_key,request_hash,response_status,response_body,created_at) values (?,?,?,?,?,?)",
        ).bind(
          workspaceId,
          `replay:${delivery.id}:${idempotencyKey}`,
          requestHash,
          202,
          JSON.stringify(responseBody),
          timestamp,
        ),
      );
    }
    await env.EVENTS_DB.batch(statements);
    if (access.kind === "session") {
      await env.CONTROL_DB.prepare(
        "insert into governance_audit_events (id,workspace_id,actor_identity_id,session_id,kind,subject_id,metadata,created_at) values (?,?,?,?,?,?,?,?)",
      )
        .bind(
          crypto.randomUUID(),
          workspaceId,
          access.identityId,
          access.sessionId,
          "delivery_replayed",
          delivery.id,
          JSON.stringify({ actor: actorId(access), reason }),
          timestamp,
        )
        .run();
    }
    try {
      await env.INGEST_QUEUE.send(message);
      await env.EVENTS_DB.prepare(
        "update outbox set published_at = ? where id = ? and published_at is null",
      )
        .bind(new Date().toISOString(), outboxId)
        .run();
    } catch {
      console.error(
        JSON.stringify({
          event: "delivery_queue_publish_deferred",
          deliveryId: delivery.id,
          workspaceId,
        }),
      );
    }
    return json(responseBody, 202);
  }

  return problem(405, "METHOD_NOT_ALLOWED", "Unsupported method.");
}
