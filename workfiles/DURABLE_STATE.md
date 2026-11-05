# Durable control-plane state (`EVENTFORGE_STORE=cloudflare`)

By default a local control plane keeps everything in memory. With `EVENTFORGE_STORE=cloudflare`
it persists its state in the `eventforge-state` Worker (`apps/state`).

## Design

- **Storage.** One SQLite-backed Durable Object (`WorkspaceState`) per workspace, addressed with
  `idFromName("workspace:<id>")`. Records are upserted by `(collection, id)`. `seq` keeps creation
  order. A partial unique index on the event dedupe key makes redeliveries idempotent server side:
  the first event id for a dedupe key wins. A `StateRegistry` object lists the workspaces that have
  state.
- **What is stored.** Events (already redacted, as kept in memory), workflows and policies, runs,
  action proposals and approvals, audit entries, memory summaries and forge drafts. Delivery dedupe
  comes from the stored events.
- **Plane.** The in-memory `EventForgeStore` stays the read path. Each mutation emits a change. The
  `CloudflareStateSync` writes it through in the background. Changes are coalesced per record, sent
  in batches of up to 200 records or 3 MB, and appended to `EVENTFORGE_STATE_SPOOL` until
  acknowledged. Failures are retried with backoff (1 s to 30 s), logged with `err`, and reported in
  `/health` under `store` (`connected`, `pending`, `lastError`). The request path never waits on
  Cloudflare.
- **Startup.** The plane hydrates every workspace (paged, 1000 records per call) and replays the
  spool on top. If the Worker stays unreachable for `EVENTFORGE_STATE_HYDRATE_TIMEOUT_MS`, the
  process exits non-zero instead of serving an empty plane. On SIGTERM it drains queued writes for up
  to 5 s, and the spool covers anything left.
- **Built-in workflows** have deterministic ids (`builtinWorkflowId`), so persisted runs and
  proposals keep resolving. Their definition comes from configuration on every start. A policy edit
  to a built-in lasts until the next restart; custom workflows persist as edited.

## Worker API (bearer `STATE_API_TOKEN`)

- `GET /health` (no auth)
- `GET /v1/workspaces`
- `POST /v1/workspaces/:id/changes` with `{"changes":[{"collection","id","body"}]}`. Up to 500
  changes and 4 MB per request, 1.9 MB per record. A batch is applied atomically.
- `GET /v1/workspaces/:id/records?after=<seq>&limit=<n>`
- `GET /v1/workspaces/:id/counts`

## Deploy

```bash
cd apps/state
openssl rand -hex 32 | npx wrangler secret put STATE_API_TOKEN   # same value as EVENTFORGE_STATE_TOKEN
npx wrangler deploy
```
