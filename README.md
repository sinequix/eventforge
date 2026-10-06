# EventForge

EventForge is a local-first, policy-first operations console and an emerging Cloudflare-native control plane for event-driven Codex workflows. It receives signed events, creates read-only agent investigations, keeps scoped project memory, and requires explicit approval for consequential actions. Hosted production routing remains intentionally disabled until its authentication, tenancy, and reliability gates pass.

## Architecture

```mermaid
flowchart LR
  providers["Providers"] -->|"signed webhook"| hooks["hooks.eventforge.dev Worker"]
  operators["Console · API · MCP"] --> api["api.eventforge.dev Worker"]
  hooks --> r2["Encrypted payloads · R2"]
  hooks --> d1["Tenant metadata · D1"]
  hooks --> queue["Cloudflare Queues"]
  queue --> delivery["Idempotent delivery processing"]
  api --> d1
  api --> workflows["Workflows · approvals · replay"]
  workflows --> sandbox["Short-lived investigations"]

  codex["Codex plugin"] --> mcp["Local EventForge MCP"]
  mcp -->|"loopback only"| local["Fastify · Electron · private edge"]
  local -->|"optional local relay"| tunnel["Cloudflare Tunnel"]
  local --> approval["Approval-gated actions"]
```

The local/private-edge path keeps Fastify, Electron, MCP stdio, Cloudflare Tunnel, and the local Codex runner. The hosted path uses Worker custom domains, D1, private R2, Queues, and Workflows; it never depends on Tunnel-backed API DNS. `api.eventforge.dev` and `hooks.eventforge.dev` are attached to the production Worker with isolated production resources, while authenticated APIs, webhook ingress, and the hosted console remain fail-closed until their release gates pass.

## Included features

| Area                | Included capability                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event ingestion     | GitHub, Linear, and Sentry adapters; raw-body HMAC verification; replay checks; process-lifetime delivery deduplication; payload redaction                      |
| Managed local relay | MCP-triggered startup; Quick Tunnel and manual named-tunnel fallbacks; owner-scoped three-word managed hostnames; automatic GitHub webhook patching             |
| Agent workflows     | Persistent Codex SDK thread IDs for the active process, structured investigations, issue and pull-request review, policy-bounded read-only analysis             |
| Safety              | Default approval-required workflows, resource-aware policy decisions, immutable decision versions, public-ingress route restrictions, rate and Codex-run quotas |
| MCP and plugin      | Compiled stdio and loopback Streamable HTTP transports, nine stable tools, native Codex plugin bundle, optional health-only lifecycle hook                      |
| Operations console  | Live events, workflows, runs, approvals, Forge Studio, connector health, memory/audit search, responsive light/dark interface                                   |
| Desktop and memory  | Packaged Electron main/preload/renderer boundary, private user-data daemon, SQLite store, explicit disabled vector-index status                                 |
| Forge Studio        | Reviewable connector specification and generated files, requested scopes, static validation, explicit owner approval; no hot-loading                            |
| Delivery            | Docker Compose, hardened non-root image, Helm chart, Cloudflare Worker deployment, package smoke tests, CodeQL, secret scanning, dependency audit               |
| Hosted foundation   | Split D1 control/event stores, encrypted private R2 payloads, Queue plus DLQ bindings, idempotent outbox ingestion, and gated signed-canary acceptance          |

## Recent production-hardening upgrades

- Added the isolated Cloudflare-native preview Worker and provisioned preview D1, R2, Queue, and DLQ resources without changing the production domains.
- Proved signed canary receipt through encrypted payload storage, durable metadata/outbox/audit writes, Queue publication, and consumer completion; preview ingress was gated again after the test.
- Added per-user/workspace Cloudflare tunnel provisioning with deterministic three-word hostnames, idempotent DNS/configuration, tunnel-scoped credentials, protected token files, and failure/shutdown cleanup.
- Made `listen_for_webhook` start the local relay on demand and return the active provider endpoint without exposing tunnel credentials.
- Restricted public tunnel traffic to `/health` and exact signed webhook paths while keeping console, memory, workflow, and approval APIs loopback-only.
- Replaced generic provider verification with provider-specific GitHub, Linear, and Sentry signature, replay, installation-scope, and deduplication contracts.
- Added resource-aware policy checks, versioned approval transitions, structured Codex results, resumable thread support, durable PostgreSQL/queue foundations, and truthful local-memory status.
- Compiled and package-tested the MCP server/plugin, packaged Electron with its preload boundary, added coverage gates, and added reproducible CI, deployment, audit, and secret-scan checks.

## Hackathon submission

- **Code repository:** [github.com/tebayoso/eventforge](https://github.com/tebayoso/eventforge)

### How Codex and GPT-5.6 were used

Codex, using GPT-5.6, was the engineering collaborator for EventForge: it translated the product requirements into the TypeScript monorepo, implemented the event-ingestion, policy, approval, memory, MCP/plugin, and operations-console flows, and ran the test, build, and browser-validation loops.

The product also uses the Codex SDK at runtime. A verified GitHub event can create a read-only Codex thread that reviews untrusted engineering evidence within the workflow's policy boundary; EventForge retains its thread ID in the active local store so a repeated run can resume it. Durable restart recovery is tracked separately and is not claimed by this release.

The complete Devpost-ready title, story, tags, installation method, and final-submission checklist are in [workfiles/devpost/SUBMISSION.md](workfiles/devpost/SUBMISSION.md).

## Zero-checkout MCP setup

For the complete mode selection, environment reference, Codex TOML examples,
remote HTTP requirements, and verification checklist, see
[the canonical configuration guide](workfiles/CONFIGURATION.md).

The MCP package can start a credential-free local EventForge control plane automatically. A new user does not need an EventForge checkout for this path; Codex downloads the self-contained launcher from the public GitHub repository:

```bash
codex mcp add eventforge --env EVENTFORGE_CODEX_WORKDIR="$PWD" -- npx -y --package github:tebayoso/eventforge eventforge-mcp
```

Restart Codex, then use `/mcp` to confirm the `eventforge` server is connected. The launcher starts a local API on `http://127.0.0.1:4310`, uses the deterministic demo runner by default, and keeps the same approval-gated tools as the repository plugin. Set `EVENTFORGE_API_URL` to an already-running local API to disable automatic startup; set `EVENTFORGE_AUTO_START=false` when the MCP process must never launch a local control plane.

For a package registry release, the equivalent configuration is:

```toml
[mcp_servers.eventforge]
command = "npx"
args = ["-y", "@eventforge/mcp-server"]
env = { EVENTFORGE_CODEX_WORKDIR = "/absolute/path/to/project" }
```

The scoped npm package is publish-ready but is not yet present in the public registry. Until it is published, use the GitHub package spec above.

For a remote Streamable HTTP host, configure Codex with the host URL and OAuth or a secret supplied by the host administrator:

```toml
[mcp_servers.eventforge]
url = "https://mcp.example.com/mcp"
auth = "oauth"
default_tools_approval_mode = "writes"
```

The packaged HTTP launcher is `eventforge-mcp-http`. It binds to loopback by default and must sit behind the host's TLS and OAuth boundary before being exposed remotely. EventForge intentionally refuses direct non-loopback binding without its OAuth 2.1 authorization layer.

## Demo video

[Watch the EventForge demo on YouTube](https://youtu.be/pht3rrl--pE) for the end-to-end operations-console, GitHub-event, Codex-review, and approval workflow.

## Quick start

Prerequisites: Node.js 22.17 or newer and pnpm 11.5.1. Docker is optional for PostgreSQL/MinIO. The live GitHub flow additionally needs authenticated `gh` and Codex CLIs, `cloudflared`, and repository webhook-administration permission.

Use the repository-pinned pnpm version. Node.js 22–24 normally provide Corepack; Node.js 25 and newer require a separate package-manager install:

```bash
corepack enable && corepack prepare pnpm@11.5.1 --activate
# If `corepack` is not installed:
npm install --global pnpm@11.5.1
```

Install and start the credential-free demo control plane:

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm dev
```

In a second terminal, start the browser console:

```bash
pnpm dev:console
```

Open `http://localhost:5173`, then select **Run GitHub CI demo**. The control plane is at `http://localhost:4310`.

To run the Worker, console, and control plane together behind `https://dev.eventforge.dev` (named Cloudflare Tunnel, loopback bind only):

```bash
./dev.sh                  # supervise until Ctrl-C
./dev.sh start --remote   # local processes, preview D1/R2
./dev.sh stop
```

For the shortest walkthrough, run the demo event, inspect the resulting agent run and approval proposal, then compare the flow with the [demo video](https://youtu.be/pht3rrl--pE).

`docker compose up -d` starts the PostgreSQL/pgvector and MinIO development dependencies. The control-plane container remains behind the `app` profile because remote mode deliberately refuses to start until authentication is injected; run the local control plane with `pnpm dev`. Provider OAuth credentials are never included in this repository.

To exercise the Codex SDK instead of the deterministic runner, provide `OPENAI_API_KEY` externally and start the API with `EVENTFORGE_RUNNER=codex pnpm dev`. Analysis remains read-only and any proposed write remains approval-gated.

## Quality and package checks

```bash
pnpm quality
pnpm audit --prod --audit-level high
pnpm --filter @eventforge/desktop package
```

`pnpm quality` checks formatting, lint, compiled production entry points, types, coverage, the packed MCP npm artifact, and an installed-copy plugin handshake. The plugin bundles its server and does not rely on a globally installed executable. Restart Codex after adding or updating the plugin so its MCP registry is discovered; lifecycle hooks are optional and separately trust-reviewed.

See the [Codex plugin installation](plugins/eventforge/README.md) and [Electron package troubleshooting](workfiles/TROUBLESHOOTING.md#electron-packaging-fails) instructions for those optional surfaces.

## Test a real GitHub webhook through Cloudflare locally

GitHub cannot deliver a webhook directly to `localhost`, so EventForge starts a local Cloudflare relay. Starting GitHub mode creates a random local webhook secret in the ignored `.env`, creates (or reuses) exactly one webhook subscribed to `check_run`, `issues`, `pull_request`, `pull_request_review`, and `issue_comment` through the authenticated `gh` CLI, and patches that webhook to the active public URL on every launch. The tunnel forwards signed deliveries to the control plane, which acknowledges them before running Codex work in the background.

In the first terminal:

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm dev:github
```

In a second terminal:

```bash
pnpm dev:console
```

`cloudflared` must be on your `PATH` (for macOS: `brew install cloudflared`). Set `EVENTFORGE_CLOUDFLARED_BIN` if it is installed elsewhere. Without managed-tunnel settings, EventForge starts a credential-free Quick Tunnel with an empty Cloudflare configuration so unrelated named-tunnel files cannot alter the local webhook route. If a Quick Tunnel publishes a hostname that never becomes healthy, EventForge closes it and retries with a fresh hostname before touching GitHub.

The preferred hosted flow assigns a stable hostname made from three pronounceable pseudorandom words to each actor/workspace, such as `dalimo-fugera-nupasi.eventforge.dev`. Set `EVENTFORGE_TUNNEL_PROVISIONING_URL` to the authenticated remote EventForge API and `EVENTFORGE_TUNNEL_PROVISIONING_TOKEN` to a short-lived owner token. The hosted API—not the MCP client—holds the Cloudflare account credential, creates or reuses the tunnel and DNS record, and returns only a tunnel-scoped token. The local daemon stores that token in ignored `.eventforge/` with mode `0600` and passes it to `cloudflared` through `--token-file`, keeping it out of process arguments. Managed provisioning remains unavailable on the public deployment until remote authentication and valid Cloudflare account/zone secrets are configured.

With the local API running, the MCP `listen_for_webhook` tool calls `POST /relay/ensure`. That starts the relay once on demand and returns the selected provider endpoint without returning its credential. GitHub registration is patched during that startup; Linear and Sentry expose their signed ingress paths on the same relay but still require their provider secrets and provider-side webhook configuration.

As a manual fallback, create and route a named Cloudflare Tunnel, then set both `EVENTFORGE_CLOUDFLARED_TUNNEL` and `EVENTFORGE_CLOUDFLARED_PUBLIC_URL` in the ignored `.env`. The same `pnpm dev:github` command starts that tunnel, verifies its public `/health` endpoint, and patches the repository webhook on every launch. If either setting is missing, startup fails closed instead of silently using the wrong tunnel.

Leave both processes running, then open `http://localhost:5173`. Use the **EventForge CI failure demo** GitHub Actions workflow's **Run workflow** button, or dispatch it from the terminal:

```bash
gh workflow run "EventForge CI failure demo" --repo OWNER/REPOSITORY
```

The workflow fails intentionally. Once GitHub finishes it, the console shows a verified GitHub event, a read-only agent investigation, and an approval-gated remediation proposal. You can inspect the raw local event stream with `curl http://127.0.0.1:4310/events`. The public webhook endpoint and webhook id are stored in ignored `.eventforge/github-local-webhook.json`; remove the corresponding repository webhook in GitHub when you are done. Quick Tunnels are for local testing only, never production traffic.

## Review a new GitHub issue in Codex

Local GitHub mode also subscribes to `issues` events. Opening an issue creates a fresh Codex SDK thread in read-only mode, scoped to this repository. Its thread ID and review summary appear in the EventForge **Agent run log** for the lifetime of the local process; issue reviews never create a GitHub comment, branch, or pull request automatically.

```bash
gh issue create --repo OWNER/REPOSITORY \
  --title "Review this engineering issue" \
  --body "Describe the problem, expected behavior, and relevant context."
```

`pnpm dev:github` runs the Codex-backed runner. Keep the process running until the issue appears in the dashboard as a completed run; the issue text is treated as untrusted input and the Codex thread is configured read-only. GitHub receives `202 Accepted` immediately, while the review continues in a thread whose ID is retained for the current process.

## Review a pull request in Codex

With `pnpm dev:github` running, opening a pull request starts one read-only Codex SDK review thread. Reopening the PR or pushing a new head commit resumes the retained thread for that PR. EventForge also records review and conversation deliveries for audit, but never follows instructions embedded in PR descriptions or comments and never performs a GitHub write automatically.

The local acceptance signal is a GitHub `pull_request` delivery returning `202`, followed by a `verified` event and completed run with a `threadId`:

```bash
curl http://127.0.0.1:4310/events
curl http://127.0.0.1:4310/runs
```

Delivery deduplication and thread retention in local mode last only for the current process. Production durability remains part of the remote control-plane milestone.

## Packages

- `apps/control-plane` — webhook relay, workflow/policy engine, agent-run orchestration, audit API.
- `apps/console` — React operations console; the Electron shell embeds this surface.
- `apps/desktop` — packaged Electron companion and private SQLite memory daemon; vector indexing reports disabled until implemented.
- `packages/core` — contracts, signature verification, policy evaluation, memory, and guarded forge logic.
- `packages/mcp-server` — Codex MCP server that controls the local/cloud EventForge API.
- `plugins/eventforge` — native Codex plugin manifest, MCP registration, skill, and opt-in hook.

## Safety model

Incoming provider data is untrusted. EventForge verifies signatures, deduplicates deliveries for the lifetime of the local process, redacts known secret patterns, and treats generated connectors as untrusted until validation and explicit approval. All workflow writes default to `approval_required`; workflow owners can grant narrow policies later. Restart-safe deduplication requires the Track B PostgreSQL repository wiring.

Approval records state and reviewer identity but does not execute or hot-load generated code. Forge Studio currently generates and statically scans a reviewable draft; isolated execution, immutable artifact storage, remote MFA/OAuth, and full PostgreSQL restart recovery remain Track B work.

See the [configuration guide](workfiles/CONFIGURATION.md), [architecture and trust boundaries](workfiles/ARCHITECTURE.md), [implementation status](workfiles/STATUS.md), [contribution guidance](workfiles/CONTRIBUTING.md), [security reporting](workfiles/SECURITY.md), [threat model](workfiles/THREAT_MODEL.md), [troubleshooting](workfiles/TROUBLESHOOTING.md), and the [Apache-2.0 license](LICENSE).
