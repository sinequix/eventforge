# EventForge CI failure demo

Target length: under 90 seconds of talking, with the control plane already built. Do this in an interactive Hermes CLI session. Cron and the messaging gateway will refuse the relay step.

## 0. Once per checkout

```bash
pnpm install --frozen-lockfile
pnpm --filter @eventforge/mcp-server bundle:plugin
```

## 1. Start the plane and Hermes (about 20s)

Terminal A, from the repo root. Leave it running. Closing stdin stops the plane.

```bash
node plugins/eventforge/server/eventforge-standalone.cjs
```

Terminal B:

```bash
hermes plugins install ./plugins/hermes-eventforge
hermes plugins enable eventforge
hermes
```

In the session:

```text
/eventforge status
```

Expect `ok=True` and `service=eventforge-control-plane`.

## 2. Listen (about 15s)

```text
Call ef_listen_for_webhook for github. Tell me the endpoint and do not approve anything else.
```

Hermes calls `ef_listen_for_webhook`. The local plane returns the verified GitHub webhook endpoint. No Hermes approval prompt should appear for this read-to-relay call.

## 3. Trigger the failure (about 15s)

In another shell, after the hook from step 2 is registered on `sinequix/eventforge`:

```bash
gh workflow run "EventForge CI failure demo" --repo sinequix/eventforge
```

The workflow is manual and exits 1 on purpose (`.github/workflows/eventforge-ci-failure-demo.yml`). GitHub delivers `check_run`. The plane stores it as `signatureStatus: verified` when the webhook signature matches.

## 4. Investigate, then approve (about 30s)

```text
A verified CI failure just arrived. Use the eventforge:triage skill. Investigate read-only and propose the fix. Do not approve an action until I say so.
```

`pre_llm_call` injects the new verified event. Hermes should call `ef_list_events` and `ef_query_memory`, then describe the failure. The demo workflow's only step is an intentional `exit 1`, so the proposed fix is to treat that step as the demonstration signal rather than a product bug.

When you want the analysis run:

```text
Start the analysis run for that event.
```

Hermes calls `ef_spawn_subagent`. The `pre_tool_call` hook asks you to approve. Approve it in Hermes. That approval is Hermes's, not an EventForge auto-approval. If a proposal comes back, approving `ef_approve_action` asks you a second time.

## 5. Replay (about 10s)

```text
/eventforge events
/eventforge replay <event-id>
```

The replay is read-only. It prints the stored event and any audit lines that mention it. It does not re-run the workflow.
