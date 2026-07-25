import { handleAuth } from "./auth-routes.js";
import { encryptPayload, sha256, verifyHmac } from "./crypto.js";
import {
  DELIVERY_LEASE_MS,
  SafeDeliveryReason,
  deliveryIdempotencyKey,
  retryState,
} from "@eventforge/core";
export { SessionAuthority, authorityObjectName, sessionAuthorityFor } from "./session-authority.js";

type IngestMessage = {
  deliveryId: string;
  workspaceId: string;
  installationId: string;
  provider: string;
  correlationId: string;
};
type Surface = "api" | "hooks" | "preview" | "unknown";
type WaitlistPayload = {
  email?: unknown;
  source?: unknown;
  consent?: unknown;
  website?: unknown;
};

const MCP_TOOLS = [
  "listen_for_webhook",
  "emit_event",
  "query_memory",
  "spawn_subagent",
  "approve_action",
  "forge_mcp",
  "approve_forge",
  "list_events",
  "list_workflows",
].map((name) => ({
  name,
  description: `EventForge ${name.replaceAll("_", " ")} tool.`,
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
}));

function mcpJson(id: unknown, result: unknown): Response {
  return Response.json(
    { jsonrpc: "2.0", id, result },
    { headers: { "mcp-session-id": "eventforge-demo" } },
  );
}

async function mcp(request: Request): Promise<Response> {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    message = (await request.json()) as typeof message;
  } catch {
    return problem(400, "INVALID_JSON", "MCP request must be valid JSON.");
  }
  if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (message.method === "initialize") {
    return mcpJson(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "eventforge", version: "0.1.0" },
      instructions:
        "Read-only demo MCP surface. Authenticate before customer-scoped operations are enabled.",
    });
  }
  if (message.method === "tools/list") return mcpJson(message.id, { tools: MCP_TOOLS });
  if (message.method === "tools/call") {
    const name = String(message.params?.name ?? "");
    if (["query_memory", "list_events", "list_workflows"].includes(name)) {
      return mcpJson(message.id, {
        content: [
          { type: "text", text: JSON.stringify({ workspaceId: "demo-workspace", items: [] }) },
        ],
      });
    }
    return Response.json(
      {
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: { code: -32001, message: "Authentication required for this operation." },
      },
      { status: 401 },
    );
  }
  return Response.json(
    {
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: { code: -32601, message: "Method not found." },
    },
    { status: 404 },
  );
}

export function surfaceFor(hostname: string, environment: string): Surface {
  if (environment !== "production") return "preview";
  if (hostname === "api.eventforge.dev") return "api";
  if (hostname === "hooks.eventforge.dev") return "hooks";
  return "unknown";
}

function problem(
  status: number,
  code: string,
  detail: string,
  requestId = crypto.randomUUID(),
  extraHeaders?: HeadersInit,
): Response {
  return Response.json(
    { type: "about:blank", title: code, status, code, retryable: status >= 500, detail, requestId },
    {
      status,
      headers: { "content-type": "application/problem+json", ...extraHeaders },
    },
  );
}

const WAITLIST_ORIGINS = new Set([
  "https://eventforge.dev",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function waitlistCors(origin: string | null): HeadersInit {
  const headers: HeadersInit = { vary: "Origin" };
  if (origin && WAITLIST_ORIGINS.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "POST, OPTIONS";
    headers["access-control-allow-headers"] = "content-type";
    headers["access-control-max-age"] = "86400";
  }
  return headers;
}

export function normalizeWaitlistEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

async function joinWaitlist(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("origin");
  const cors = waitlistCors(origin);
  if (origin && !WAITLIST_ORIGINS.has(origin))
    return problem(
      403,
      "ORIGIN_NOT_ALLOWED",
      "Waitlist submissions must originate from EventForge.",
      undefined,
      cors,
    );
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST")
    return problem(405, "METHOD_NOT_ALLOWED", "Use POST to join the waitlist.", undefined, {
      ...cors,
      allow: "POST, OPTIONS",
    });
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 8192)
    return problem(
      413,
      "PAYLOAD_TOO_LARGE",
      "Waitlist submissions must be smaller than 8 KB.",
      undefined,
      cors,
    );

  let payload: WaitlistPayload;
  try {
    const raw = await request.text();
    if (raw.length > 8192) throw new Error("payload too large");
    payload = JSON.parse(raw) as WaitlistPayload;
  } catch {
    return problem(400, "INVALID_JSON", "Waitlist submission must be valid JSON.", undefined, cors);
  }

  // Honeypot: pretend bot submissions succeeded without persisting them.
  if (typeof payload.website === "string" && payload.website.trim())
    return Response.json({ accepted: true }, { status: 202, headers: cors });

  const email = normalizeWaitlistEmail(payload.email);
  if (!email) return problem(400, "INVALID_EMAIL", "Enter a valid email address.", undefined, cors);
  if (payload.consent !== true)
    return problem(
      400,
      "CONSENT_REQUIRED",
      "Consent is required to join the waitlist.",
      undefined,
      cors,
    );

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const rateLimitSecret = env.WAITLIST_RATE_LIMIT_SECRET || `local-${env.ENVIRONMENT}`;
  const ipHash = await sha256(`${rateLimitSecret}:${ip}`);
  const threshold = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await env.CONTROL_DB.prepare(
    "select count(*) as count from waitlist_signups where ip_hash = ? and created_at > ?",
  )
    .bind(ipHash, threshold)
    .first<{ count: number }>();
  if (Number(recent?.count ?? 0) >= 5)
    return problem(429, "RATE_LIMITED", "Please try again later.", undefined, {
      ...cors,
      "retry-after": "3600",
    });

  const now = new Date().toISOString();
  const source =
    typeof payload.source === "string" ? payload.source.trim().slice(0, 64) || "direct" : "direct";
  const result = await env.CONTROL_DB.prepare(
    "insert into waitlist_signups (id,email,source,consent_at,ip_hash,created_at) values (?,?,?,?,?,?) on conflict(email) do nothing",
  )
    .bind(crypto.randomUUID(), email, source, now, ipHash, now)
    .run();
  return Response.json(
    { accepted: true, alreadyRegistered: Number(result.meta.changes ?? 0) === 0 },
    { status: 202, headers: cors },
  );
}

async function publishOutbox(env: Env, limit = 100): Promise<number> {
  const pending = await env.EVENTS_DB.prepare(
    "select id, payload from outbox where published_at is null order by created_at limit ?",
  )
    .bind(limit)
    .all<{ id: string; payload: string }>();
  let published = 0;
  for (const row of pending.results) {
    await env.INGEST_QUEUE.send(JSON.parse(row.payload) as IngestMessage);
    const now = new Date().toISOString();
    await env.EVENTS_DB.batch([
      env.EVENTS_DB.prepare(
        "update outbox set published_at = ? where id = ? and published_at is null",
      ).bind(now, row.id),
      env.EVENTS_DB.prepare(
        "update deliveries set status = 'queued', updated_at = ? where id = ? and status = 'accepted'",
      ).bind(now, (JSON.parse(row.payload) as IngestMessage).deliveryId),
    ]);
    published += 1;
  }
  return published;
}

async function publishOutboxBestEffort(
  env: Env,
  delivery: Pick<IngestMessage, "deliveryId" | "workspaceId">,
): Promise<void> {
  try {
    await publishOutbox(env);
  } catch {
    console.error(
      JSON.stringify({
        event: "delivery_queue_publish_deferred",
        deliveryId: delivery.deliveryId,
        workspaceId: delivery.workspaceId,
      }),
    );
  }
}

type Installation = {
  id: string;
  workspace_id: string;
  status: "active" | "suspended" | "deleted";
};

async function verifiedInstallation(
  env: Env,
  provider: string,
  installationKey: string,
): Promise<Installation | undefined> {
  return (
    (await env.CONTROL_DB.prepare(
      "select id, workspace_id, status from delivery_installations where provider = ? and installation_key = ?",
    )
      .bind(provider, installationKey)
      .first<Installation>()) ?? undefined
  );
}

async function verifiedInstallationById(
  env: Env,
  installationId: string,
  provider: string,
): Promise<Installation | undefined> {
  return (
    (await env.CONTROL_DB.prepare(
      "select id, workspace_id, status from delivery_installations where id = ? and provider = ?",
    )
      .bind(installationId, provider)
      .first<Installation>()) ?? undefined
  );
}

class DeliveryFailure extends Error {
  constructor(readonly reason: SafeDeliveryReason) {
    super(reason);
  }
}

export function safeReason(error: unknown): SafeDeliveryReason {
  if (error instanceof DeliveryFailure) return error.reason;
  const message = error instanceof Error ? error.message : "";
  if (SafeDeliveryReason.includes(message as SafeDeliveryReason))
    return message as SafeDeliveryReason;
  return "internal_error";
}

async function quarantine(
  env: Env,
  delivery: IngestMessage,
  reason: SafeDeliveryReason,
  now = new Date(),
): Promise<boolean> {
  const timestamp = now.toISOString();
  const retainUntil = new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString();
  const results = await env.EVENTS_DB.batch([
    env.EVENTS_DB.prepare(
      "update deliveries set status = 'quarantined', safe_reason = ?, quarantined_at = ?, updated_at = ?, lease_expires_at = null where id = ? and workspace_id = ? and status not in ('completed','quarantined','rejected')",
    ).bind(reason, timestamp, timestamp, delivery.deliveryId, delivery.workspaceId),
    env.EVENTS_DB.prepare(
      "insert into delivery_dlq (delivery_id,workspace_id,safe_reason,correlation_id,attempts_count,quarantined_at,retain_until) select id,workspace_id,?,?,attempts_count,?,? from deliveries where id = ? and workspace_id = ? and status = 'quarantined' and safe_reason = ? on conflict(delivery_id) do nothing",
    ).bind(
      reason,
      delivery.correlationId,
      timestamp,
      retainUntil,
      delivery.deliveryId,
      delivery.workspaceId,
      reason,
    ),
    env.EVENTS_DB.prepare(
      "insert into audit_entries (id,workspace_id,kind,subject_id,message,created_at) select ?,workspace_id,?,?,?,? from deliveries where id = ? and workspace_id = ? and status = 'quarantined' and safe_reason = ?",
    ).bind(
      crypto.randomUUID(),
      "delivery_quarantined",
      delivery.deliveryId,
      `delivery quarantined: ${reason}`,
      timestamp,
      delivery.deliveryId,
      delivery.workspaceId,
      reason,
    ),
  ]);
  return Number(results[0]?.meta.changes ?? 0) > 0;
}

/** Repairs only stale queue/lease state; completed writes are atomic with outcomes and usage. */
export async function reconcileDeliveries(env: Env, limit = 100): Promise<number> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - DELIVERY_LEASE_MS).toISOString();
  const stale = await env.EVENTS_DB.prepare(
    "select id,workspace_id,installation_id,provider,correlation_id,status,attempts_count,first_attempt_at,payload_ref,payload_checksum from deliveries where (status in ('accepted','queued') and created_at <= ?) or (status = 'processing' and lease_expires_at <= ?) or (status = 'retrying' and next_retry_at <= ?) limit ?",
  )
    .bind(staleBefore, now.toISOString(), now.toISOString(), limit)
    .all<{
      id: string;
      workspace_id: string;
      installation_id: string;
      provider: string;
      correlation_id: string;
      status: "accepted" | "queued" | "processing" | "retrying";
      attempts_count: number;
      first_attempt_at: string | null;
      payload_ref: string;
      payload_checksum: string;
    }>();
  let reconciled = 0;
  for (const row of stale.results) {
    const body: IngestMessage = {
      deliveryId: row.id,
      workspaceId: row.workspace_id,
      installationId: row.installation_id,
      provider: row.provider,
      correlationId: row.correlation_id,
    };
    const installation = await verifiedInstallationById(env, row.installation_id, row.provider);
    if (!installation || installation.workspace_id !== row.workspace_id) {
      if (await quarantine(env, body, "workspace_deleted", now)) reconciled += 1;
      continue;
    }
    if (installation.status !== "active") {
      const reason =
        installation.status === "deleted" ? "workspace_deleted" : "workspace_suspended";
      if (await quarantine(env, body, reason, now)) reconciled += 1;
      continue;
    }
    const payload = await env.PAYLOADS.head(row.payload_ref);
    if (!payload) {
      if (await quarantine(env, body, "payload_unavailable", now)) reconciled += 1;
      continue;
    }
    if (
      payload.customMetadata?.checksum !== row.payload_checksum ||
      !payload.customMetadata?.nonce
    ) {
      if (await quarantine(env, body, "payload_corrupt", now)) reconciled += 1;
      continue;
    }
    const next = retryState({
      attempts: Number(row.attempts_count),
      firstAttemptAt: row.first_attempt_at ? Date.parse(row.first_attempt_at) : undefined,
      now: now.getTime(),
      reason: "reconciliation",
      jitterKey: row.id,
    });
    if (next.state === "quarantined") {
      await quarantine(env, body, next.reason, now);
      reconciled += 1;
      continue;
    }
    const timestamp = now.toISOString();
    const transition = await env.EVENTS_DB.prepare(
      "update deliveries set status = 'queued', safe_reason = 'reconciliation', next_retry_at = null, lease_expires_at = null, updated_at = ? where id = ? and workspace_id = ? and ((status in ('accepted','queued') and created_at <= ?) or (status = 'processing' and lease_expires_at <= ?) or (status = 'retrying' and next_retry_at <= ?))",
    )
      .bind(timestamp, row.id, row.workspace_id, staleBefore, timestamp, timestamp)
      .run();
    if (Number(transition.meta.changes ?? 0) === 0) continue;
    if (row.status === "processing") {
      await env.EVENTS_DB.prepare(
        "update delivery_attempts set status = 'failed', safe_reason = 'reconciliation', finished_at = ?, lease_expires_at = null where workspace_id = ? and delivery_id = ? and status = 'processing'",
      )
        .bind(timestamp, row.workspace_id, row.id)
        .run();
    }
    await env.INGEST_QUEUE.send(body);
    reconciled += 1;
  }
  return reconciled;
}

async function ingestCanary(request: Request, env: Env): Promise<Response> {
  if (String(env.PUBLIC_INGRESS_ENABLED) !== "true")
    return problem(
      503,
      "INGRESS_GATED",
      "Hosted production ingress has not passed its release gates.",
    );
  const signature = request.headers.get("x-eventforge-signature") ?? "";
  const deliveryId = request.headers.get("x-eventforge-delivery-id") ?? "";
  const installationKey = request.headers.get("x-eventforge-installation-key") ?? "";
  if (!deliveryId)
    return problem(400, "DELIVERY_ID_REQUIRED", "x-eventforge-delivery-id is required.");
  const raw = await request.arrayBuffer();
  if (!(await verifyHmac(raw, signature, env.CANARY_WEBHOOK_SECRET)))
    return problem(401, "INVALID_SIGNATURE", "Webhook signature verification failed.");
  if (String(env.DURABLE_DELIVERY_ENABLED) !== "true" || String(env.MONITORING_ENABLED) !== "true")
    return problem(503, "DELIVERY_GATED", "Durable delivery release gates have not passed.");
  if (!installationKey)
    return problem(503, "IDENTITY_GATED", "Verified installation mapping is required.");
  const installation = await verifiedInstallation(env, "custom", installationKey);
  if (!installation)
    return problem(503, "IDENTITY_GATED", "Verified installation mapping is required.");
  if (installation.status !== "active")
    return problem(403, "WORKSPACE_INACTIVE", "Workspace is not active for delivery processing.");
  const checksum = await sha256(raw);
  const idempotencyKey = `canary:${deliveryId}`;
  const existing = await env.EVENTS_DB.prepare(
    "select id from deliveries where workspace_id = ? and provider = ? and provider_delivery_id = ?",
  )
    .bind(installation.workspace_id, "custom", deliveryId)
    .first<{ id: string }>();
  if (existing) {
    await publishOutboxBestEffort(env, {
      deliveryId: existing.id,
      workspaceId: installation.workspace_id,
    });
    return Response.json(
      { accepted: true, duplicate: true, eventId: existing.id },
      { status: 202 },
    );
  }
  const eventId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const payloadRef = `${installation.workspace_id}/${eventId}`;
  const encrypted = await encryptPayload(raw, env.PAYLOAD_MASTER_KEY);
  await env.PAYLOADS.put(payloadRef, encrypted.body, {
    customMetadata: { nonce: encrypted.nonce, checksum },
  });
  const now = new Date().toISOString();
  const message: IngestMessage = {
    deliveryId: eventId,
    workspaceId: installation.workspace_id,
    installationId: installation.id,
    provider: "custom",
    correlationId: crypto.randomUUID(),
  };
  try {
    await env.EVENTS_DB.batch([
      env.EVENTS_DB.prepare(
        "insert into deliveries (id,workspace_id,installation_id,provider,provider_delivery_id,payload_ref,payload_checksum,status,correlation_id,created_at,updated_at) values (?,?,?,?,?,?,?,'accepted',?,?,?)",
      ).bind(
        eventId,
        installation.workspace_id,
        installation.id,
        "custom",
        deliveryId,
        payloadRef,
        checksum,
        message.correlationId,
        now,
        now,
      ),
      env.EVENTS_DB.prepare(
        "insert into outbox (id,workspace_id,operation,idempotency_key,payload,created_at) values (?,?,?,?,?,?)",
      ).bind(
        outboxId,
        installation.workspace_id,
        "ingest",
        idempotencyKey,
        JSON.stringify(message),
        now,
      ),
      env.EVENTS_DB.prepare(
        "insert into audit_entries (id,workspace_id,kind,subject_id,message,created_at) values (?,?,?,?,?,?)",
      ).bind(
        crypto.randomUUID(),
        installation.workspace_id,
        "delivery_accepted",
        eventId,
        "Verified delivery accepted with durable queue intent.",
        now,
      ),
    ]);
  } catch (error) {
    await env.PAYLOADS.delete(payloadRef);
    throw error;
  }
  // Durable receipt is acknowledged even when the asynchronous publisher is unavailable.
  // The cron publisher will retry the committed outbox record after restart.
  await publishOutboxBestEffort(env, message);
  return Response.json({ accepted: true, duplicate: false, eventId }, { status: 202 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const surface = surfaceFor(url.hostname, env.ENVIRONMENT);
    try {
      if (url.pathname === "/mcp" && url.hostname === "api.eventforge.dev") return mcp(request);
      if (surface === "unknown") return problem(404, "NOT_FOUND", "Route not found.");
      if ((surface === "api" || surface === "preview") && url.pathname === "/v1/waitlist")
        return joinWaitlist(request, env);
      if (request.method === "GET" && url.pathname === "/health")
        return Response.json({
          ok: true,
          service: "eventforge-cloud",
          environment: env.ENVIRONMENT,
          ingress: String(env.PUBLIC_INGRESS_ENABLED) === "true" ? "enabled" : "gated",
        });
      if (
        (surface === "hooks" || surface === "preview") &&
        request.method === "POST" &&
        url.pathname === "/webhooks/canary"
      )
        return ingestCanary(request, env);
      // Hosted sign-in is enabled on pre-production surfaces only. Production
      // stays deliberately closed until it passes its own release gates, so the
      // first real callers of these paths are beta operators, not customers.
      if (surface === "preview" && url.pathname.startsWith("/api/auth/"))
        return handleAuth(request, env, url);

      if (
        (surface === "api" || surface === "preview") &&
        (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/api/auth/"))
      )
        return problem(
          503,
          "AUTH_GATED",
          "Authentication and tenant repositories are not enabled yet.",
        );
      return problem(404, "NOT_FOUND", "Route not found.");
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "request_failed",
          path: url.pathname,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
      return problem(500, "INTERNAL_ERROR", "The request could not be completed.");
    }
  },
  async queue(batch: MessageBatch<IngestMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const now = new Date();
      const body = message.body;
      try {
        const installation = await verifiedInstallationById(
          env,
          body.installationId,
          body.provider,
        );
        if (!installation || installation.workspace_id !== body.workspaceId) {
          await quarantine(env, body, "workspace_deleted", now);
          message.ack();
          continue;
        }
        if (installation.status !== "active") {
          await quarantine(
            env,
            body,
            installation.status === "deleted" ? "workspace_deleted" : "workspace_suspended",
            now,
          );
          message.ack();
          continue;
        }
        const delivery = await env.EVENTS_DB.prepare(
          "select attempts_count, first_attempt_at, status, payload_ref, payload_checksum from deliveries where id = ? and workspace_id = ? and installation_id = ?",
        )
          .bind(body.deliveryId, body.workspaceId, body.installationId)
          .first<{
            attempts_count: number;
            first_attempt_at: string | null;
            status: string;
            payload_ref: string;
            payload_checksum: string;
          }>();
        if (!delivery || ["completed", "quarantined", "rejected"].includes(delivery.status)) {
          message.ack();
          continue;
        }
        const budget = retryState({
          attempts: Number(delivery.attempts_count),
          firstAttemptAt: delivery.first_attempt_at
            ? Date.parse(delivery.first_attempt_at)
            : undefined,
          now: now.getTime(),
          reason: "upstream_unavailable",
          jitterKey: body.deliveryId,
        });
        if (budget.state === "quarantined") {
          await quarantine(env, body, budget.reason, now);
          message.ack();
          continue;
        }
        const attempt = Number(delivery.attempts_count) + 1;
        const timestamp = now.toISOString();
        const lease = new Date(now.getTime() + DELIVERY_LEASE_MS).toISOString();
        const claim = await env.EVENTS_DB.prepare(
          "update deliveries set status = 'processing', attempts_count = attempts_count + 1, first_attempt_at = coalesce(first_attempt_at, ?), lease_expires_at = ?, updated_at = ? where id = ? and workspace_id = ? and installation_id = ? and attempts_count = ? and (status in ('accepted','queued','retrying') or (status = 'processing' and lease_expires_at <= ?))",
        )
          .bind(
            timestamp,
            lease,
            timestamp,
            body.deliveryId,
            body.workspaceId,
            body.installationId,
            delivery.attempts_count,
            timestamp,
          )
          .run();
        if (Number(claim.meta.changes ?? 0) === 0) {
          // Another consumer owns the lease or has already reached a terminal state.
          message.ack();
          continue;
        }
        await env.EVENTS_DB.prepare(
          "insert into delivery_attempts (id,workspace_id,delivery_id,attempt_number,operation,status,billing_effect,lease_expires_at,started_at) values (?,?,?,?,?,'processing','none',?,?)",
        )
          .bind(
            crypto.randomUUID(),
            body.workspaceId,
            body.deliveryId,
            attempt,
            "process",
            lease,
            timestamp,
          )
          .run();
        const payload = await env.PAYLOADS.head(delivery.payload_ref);
        if (!payload) throw new DeliveryFailure("payload_unavailable");
        if (
          payload.customMetadata?.checksum !== delivery.payload_checksum ||
          !payload.customMetadata?.nonce
        )
          throw new DeliveryFailure("payload_corrupt");
        const outcomeKey = deliveryIdempotencyKey(body.workspaceId, body.deliveryId);
        await env.EVENTS_DB.batch([
          env.EVENTS_DB.prepare(
            "insert into delivery_outcomes (id,workspace_id,delivery_id,idempotency_key,created_at) values (?,?,?,?,?) on conflict(workspace_id,idempotency_key) do nothing",
          ).bind(crypto.randomUUID(), body.workspaceId, body.deliveryId, outcomeKey, timestamp),
          env.EVENTS_DB.prepare(
            "insert into delivery_usage_records (id,workspace_id,delivery_id,idempotency_key,created_at) values (?,?,?,?,?) on conflict(workspace_id,idempotency_key) do nothing",
          ).bind(crypto.randomUUID(), body.workspaceId, body.deliveryId, outcomeKey, timestamp),
          env.EVENTS_DB.prepare(
            "update delivery_attempts set status = 'completed', finished_at = ?, lease_expires_at = null where workspace_id = ? and delivery_id = ? and attempt_number = ?",
          ).bind(timestamp, body.workspaceId, body.deliveryId, attempt),
          env.EVENTS_DB.prepare(
            "update deliveries set status = 'completed', completed_at = ?, lease_expires_at = null, updated_at = ? where id = ? and workspace_id = ?",
          ).bind(timestamp, timestamp, body.deliveryId, body.workspaceId),
        ]);
        message.ack();
      } catch (error) {
        const reason = safeReason(error);
        const delivery = await env.EVENTS_DB.prepare(
          "select attempts_count, first_attempt_at from deliveries where id = ? and workspace_id = ?",
        )
          .bind(body.deliveryId, body.workspaceId)
          .first<{ attempts_count: number; first_attempt_at: string | null }>();
        const next = retryState({
          attempts: Number(delivery?.attempts_count ?? 8),
          firstAttemptAt: delivery?.first_attempt_at
            ? Date.parse(delivery.first_attempt_at)
            : undefined,
          now: now.getTime(),
          reason,
          jitterKey: body.deliveryId,
        });
        if (next.state === "quarantined") {
          await quarantine(env, body, next.reason, now);
          message.ack();
        } else {
          await env.EVENTS_DB.prepare(
            "update deliveries set status = 'retrying', safe_reason = ?, next_retry_at = ?, lease_expires_at = null, updated_at = ? where id = ? and workspace_id = ?",
          )
            .bind(
              reason,
              new Date(now.getTime() + next.delaySeconds! * 1_000).toISOString(),
              now.toISOString(),
              body.deliveryId,
              body.workspaceId,
            )
            .run();
          message.retry({ delaySeconds: next.delaySeconds });
        }
      }
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      Promise.all([publishOutbox(env), reconcileDeliveries(env)]).then(() => undefined),
    );
  },
} satisfies ExportedHandler<Env, IngestMessage>;
