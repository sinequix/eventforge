# Durable tenant delivery runbook

Hosted ingress remains fail-closed until `PUBLIC_INGRESS_ENABLED`, `DURABLE_DELIVERY_ENABLED`, and `MONITORING_ENABLED` are all enabled, the queue bindings exist, and verified `delivery_installations` mappings are populated. This change does not claim a live drill. Operator replay (`POST /v1/workspaces/:id/deliveries/:id/replay`) requires an audited reason and is still gated on `DURABLE_DELIVERY_ENABLED` — do not use production replay as a test button before the canary drill.

Preview-only canary, after secret rotation: temporarily raise the three flags on **preview**, `POST /webhooks/canary` with HMAC + delivery id against an active `delivery_installations` row, reconcile R2/D1/outbox/Queue, then redeploy the gate. Do not leave preview flags on. Production stays `"false"` until that drill is signed.

Each accepted delivery writes a workspace-scoped logical delivery and outbox intent before returning `202`. Cloudflare Queue is at-least-once; outcome and usage rows use the workspace-scoped logical-delivery key. There is no exactly-once transport or global ordering claim.

Operators may inspect only metadata: state, safe reason, attempt count, retry time, correlation ID, and timestamps. Payload retrieval is a separate authorized operation. DLQ viewing/export never queues work. Authorized retry must revalidate an active mapping and creates a non-billable attempt; deletion waits for the immutable DLQ record's 30-day retention boundary and records an audit event.

Reconciliation is deliberately bounded: stale accepted/queued work, expired processing leases, and due retries are revalidated against the current installation/workspace mapping and durable payload metadata before a guarded requeue. Expired processing attempts are marked failed without creating billable usage. Completed state, outcome, usage, and attempt completion are one atomic D1 batch, so reconciliation never rewrites or quarantines a completed delivery.

Suspended and deleted mappings quarantine before any retry. Owner/admin notification and retention deletion automation remain release-gated follow-up work; this implementation does not claim either is live. Never place payloads or upstream error bodies in queue logs, DLQ metadata, or alerts.
