# Webhook-as-a-Service implementation plan

Date: 2026-08-28
Source: research against Svix, Hookdeck/Outpost, Stripe, Standard Webhooks, and this repo.

Goal: make EventForge a Svix/Hookdeck-class webhook service **without replacing the existing tenant model**. Do not introduce a parallel `app_id` product. Map environment → consumer application → endpoints onto **workspace → installation/route → destination endpoint**.

## What already exists (do not rebuild)

| Capability                                | Where                                                | Status                                            |
| ----------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| Ingest ack `202` after persist            | control-plane `app.ts`; Worker ingest                | Local live; hosted gated                          |
| Unique ingest key                         | `(workspace, provider, provider_delivery_id)`        | D1 `0002_durable_deliveries.sql`                  |
| Lease, not consume                        | `DELIVERY_LEASE_MS=60s`, `claimJob`                  | Foundation                                        |
| 8 attempts / 24h / 300s cap + jitter      | `packages/core/src/durable-delivery.ts`              | Keep this budget                                  |
| Transient vs poison classification        | `retryState` / `SafeDeliveryReason`                  | Keep                                              |
| DLQ / quarantine, inspect without enqueue | D1 deliveries + Queue DLQ; runbook                   | Hosted flags off                                  |
| Attempt ledger                            | unique `(workspace_id, delivery_id, attempt_number)` | Schema exists                                     |
| Replay as new non-billable attempt        | `ReplayService` in core; runbook                     | Hosted fail-closed (#17)                          |
| Commercial log types                      | `DeliveryAttempt`, `Delivery`, `ReplayPreview`       | Contracts only                                    |
| Inbound HMAC (GitHub/Linear/Sentry)       | `packages/core/src/events.ts`                        | Provider-specific, not Standard Webhooks outbound |
| Waitlist + invite-only sign-in            | production API                                       | Live; `/v1/*` else `AUTH_GATED`                   |

Issue **#13 explicitly excluded general outbound webhook delivery**. That is the gap this plan fills.

## Target runtime

Three hosted surfaces on Cloudflare, not a new Redis/Postgres cluster:

1. **API** (`api.eventforge.dev`) — capture, configure tenants/destinations, replay, logs metadata.
2. **Delivery worker** — Cloudflare Queue consumer; one leased HTTP attempt per matching destination.
3. **Log path** — D1 attempt rows + R2 payloads; do not share the delivery queue for log writes (second queue or `waitUntil` persist).

Keep `POST` ingest returning **202 + event/delivery id**. That means _accepted into the pipeline_, not _delivered_.

## Feature mapping and build order

### 1. Event ingestion API

- Keep signed provider webhooks on `hooks.eventforge.dev` (`/webhooks/:provider`).
- Add generic publish: `POST /v1/workspaces/:id/events` with idempotency key header.
- Persist message + payload (D1 metadata, R2 body) in one batch, then enqueue **only if** at least one destination matches filters.
- No-match messages are still stored; zero outbound POSTs.
- Producer ack is never the destination HTTP response.

**Unlock:** `PUBLIC_INGRESS_ENABLED=true` only after identity + destination CRUD exist.

### 2. Destinations (the missing product object)

Durable model: workspace → route/installation → **endpoint** (`url`, secret, event-type/channel filters, max rate, mode `best_effort` | `fifo`).

One inbound event fans out to N matching endpoints. Each fan-out item is its own delivery row (existing schema).

### 3. Async delivery

Treat queue visibility as a **lease** (`lease_expires_at`). Success = explicit complete. Timeout/crash = same item, new attempt.

- Attempt timeout 60s (already `DELIVERY_LEASE_MS`).
- HTTP 2xx success; 429/5xx/timeout retry; 4xx validation → quarantine, do not burn budget.
- Never reject valid ingest because outbound is slow; queue above destination rate.

Enable with `DURABLE_DELIVERY_ENABLED=true` once a worker actually POSTs.

### 4. Retries, backoff, DLQ

Keep current policy:

- Retry only `timeout`, `upstream_unavailable`, `rate_limited`.
- Quarantine immediately: `validation_error`, payload errors, workspace deleted/suspended, `internal_error`.
- Delay `min(300, 2^(attempt-1))` seconds × stable jitter.
- After 8 attempts or 24h from first attempt → `retry_exhausted` / DLQ.
- Operators inspect DLQ metadata; viewing does not enqueue.

### 5. HMAC (outbound)

New: **Standard Webhooks** on EventForge→subscriber POSTs.

- HMAC-SHA256 over `msg_id.timestamp.payload`
- Headers: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`
- Unique symmetric secret **per destination**
- Receivers: constant-time compare, ±300s timestamp window, `webhook-id` as consumer idempotency key
- Rotation: space-delimited signatures so current + previous secret both verify

Inbound GitHub/Linear/Sentry adapters stay as-is.

### 6. Idempotency

- Producer: client key stored atomically; replay first response (including 500s); mismatch is an error.
- Already: unique provider delivery id; `ON CONFLICT` on outcomes.
- Consumer: skip by `webhook-id` / delivery id.

### 7. Rate limiting

Two layers, not one:

- **Inbound:** per-identity hourly budget + per-endpoint burst; `429` + `Retry-After`.
- **Outbound:** per-destination max rate; honor destination `429`/`Retry-After`; excess stays Pending.

### 8. Replay

Retry ≠ replay.

- Retry: automatic, in-budget, same logical delivery.
- Replay: operator action after miss/exhaustion; **same event identity**; new attempt, `billing_effect=none`; new signed timestamp (old signatures must fail the 5-minute window).
- Requires #17 authorization + audit before exposing a hosted route.

### 9. Logs and analytics

Ship the existing contracts as authenticated APIs:

- List deliveries/attempts (metadata only).
- Payload GET is a separate authorized call.
- Telemetry stays schema 1.0.0 (no payloads/secrets/raw ids).
- Outcome metrics: do not double-count retries of the same `subjectId`.

### 10. API keys and RBAC

- Workspace membership (owner/admin/operator/viewer) for console users.
- **API keys** for machines: one key per caller, default None, per-resource Read/Write.
- Gateway auth is not enough; every ID is re-checked for tenant ownership (OWASP API1/API5).

### 11. Node SDK

Do not stretch `@eventforge/core/sdk` (connector install) or MCP tools into this.

New package `@eventforge/webhooks`: `publish`, `verify` (Standard Webhooks), `replay`. Keep MCP `emit_event` / `list_events` as the local/dev path.

## Suggested PRs

| PR  | Scope                                                                   | Depends on                       |
| --- | ----------------------------------------------------------------------- | -------------------------------- |
| A   | Destination CRUD + secrets (D1), filters, per-endpoint rate             | Identity/membership              |
| B   | Generic `POST /v1/.../events` persist+enqueue; keep `/v1` gated until A | A                                |
| C   | Queue consumer actually HTTP POSTs; Standard Webhooks sign              | A, B, `DURABLE_DELIVERY_ENABLED` |
| D   | Operator log APIs (metadata); payload GET with authz                    | C                                |
| E   | Replay API (new attempt, same event id, audit)                          | D, #17                           |
| F   | API keys + RBAC on those routes                                         | A                                |
| G   | `@eventforge/webhooks` client                                           | C, E                             |
| H   | Flip `PUBLIC_INGRESS_ENABLED` after a signed canary drill               | C–F                              |

Do not enable hosted ingress (H) until A–F have authenticated evidence in D1.

## Status 2026-08-28

A–G exist in the Worker, D1 schema, and `@eventforge/webhooks`. Control migrations 0005/0006 and events 0003 are applied on preview and production. The hosted console destination portal calls same-origin `/v1` (cookie stays Strict). Replay requires a reason and writes governance + delivery audit; payload reveal is authorized and audited. Owner/admin invite writes `identities` + `workspace_memberships` (no self-serve signup).

Still fail-closed: `PUBLIC_INGRESS_ENABLED`, `DURABLE_DELIVERY_ENABLED`, and `MONITORING_ENABLED` remain `"false"` on production. Do not flip them without a preview-only signed canary. Issue #17 remaining: recent MFA for raw payload, retention/deletion automation, export integrity. FIFO mode is stored only.

## Explicit non-goals (this slice)

- Replacing Cloudflare Queue with Redis streams
- Exactly-once delivery or global FIFO (FIFO is a later endpoint mode)
- Executing approved GitHub/Linear writes (reaction worker remains separate)
- Self-serve signup (waitlist + invite stays)

## Numeric contracts to keep

Reuse EventForge numbers rather than Svix/Stripe defaults:

- Max attempts **8**, window **24h**, lease **60s**, delay cap **300s**
- Timestamp tolerance **300s** (library default, not a Standard Webhooks SHALL)
- Retry-After honored on 429
- DLQ retention per runbook (30 days before delete)
