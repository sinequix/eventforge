# Notification sinks

Issue #23 currently establishes the fail-closed core delivery contract, exercised with fixtures only. Slack accepts only attested public/private channels where the bot is already a member. PagerDuty is constrained to its service-level Change Events endpoint, which provides context and links but does not create alerts, incidents, or notifications; capability or attestation failure suppresses delivery.

The contract uses a logical identity of event version, route version, template version, and destination. Rendered text is fixed, bounded, and neutralizes mentions, links, markup, and control-like characters — this applies to every caller-supplied field, including the source category, lifecycle state, and correlation id, not just the title and summary. Angle-bracket markup is removed by a linear scan rather than a tag regex, so no bracket survives and bracket-heavy input cannot be used to burn CPU. It includes no credentials, authorization, raw payload/evidence, prompts, model output, or action controls. Deep links remain ordinary EventForge URLs: delivery is suppressed unless the deep link is an absolute `http(s)` URL with a host, so `javascript:`, `data:`, and `file:` payloads can never be rendered. Deep links still require authentication and object/workspace authorization at open time.

No provider credentials, live provider sends, or production attestations were used in this fixture validation.

## Signed run webhook (`EVENTFORGE_NOTIFY_URL`)

The local control plane can POST a signed JSON notification to an endpoint you own when a run
reaches `completed`, `waiting_for_approval` or `failed`, and when its proposal is `approved` or
`rejected`. Set both `EVENTFORGE_NOTIFY_URL` (https, or http only on loopback, no embedded
credentials) and `EVENTFORGE_NOTIFY_SECRET`. Setting only one of them is a startup error.

Body:

```json
{
  "event": {
    "id": "…",
    "provider": "github",
    "topic": "workflow_run",
    "deliveryId": "…",
    "signatureStatus": "verified"
  },
  "run": { "id": "…", "workflowId": "…", "status": "waiting_for_approval", "summary": "…" },
  "proposal": { "id": "…", "title": "…", "status": "pending", "type": "open_pull_request" },
  "repo": "owner/repo",
  "status": "waiting_for_approval",
  "link": "https://github.com/owner/repo/actions/runs/1"
}
```

`run.summary` is agent output derived from untrusted provider evidence. Render it as text only.

Headers:

- `X-EventForge-Delivery`: a UUID, stable across retries of one notification. Use it to dedupe.
- `X-EventForge-Timestamp`: Unix seconds of this attempt.
- `X-EventForge-Event`: the `status` value.
- `X-EventForge-Signature`: `sha256=` + hex HMAC-SHA256 of `<timestamp>.<raw body>` keyed with
  `EVENTFORGE_NOTIFY_SECRET`. Verify it with a constant-time compare and reject timestamps older
  than a few minutes.

Delivery runs in the background and never blocks webhook ingestion or approval decisions. Network
errors, timeouts (10 s), `408`, `429` and `5xx` are retried up to 5 attempts with exponential
backoff (1 s, 2 s, 4 s, 8 s). Other `4xx` responses are not retried. Redirects are refused. Logs
record only the delivery id, attempt, HTTP status and destination host; never the secret, the
signature, the body, or the URL path and query. Delivery state is in memory, so notifications in
flight are lost if the process restarts.
