# EventForge configuration

This is the canonical configuration guide for EventForge. Choose one operating
mode first; do not combine the local package, checkout daemon, and remote MCP
configurations unless you are deliberately testing a migration.

## Choose an operating mode

| Mode                   | Best for                                                                | What you configure                    |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| Zero-checkout stdio    | A developer who wants EventForge available in Codex immediately         | One `codex mcp add` command           |
| Repository development | Maintainers, provider relay testing, and console work                   | `.env`, pnpm, and local processes     |
| Native Codex plugin    | Users who want skills, the bundled server, and the optional health hook | Plugin marketplace plus trust review  |
| Remote Streamable HTTP | A hosted/private EventForge MCP endpoint                                | A remote HTTPS URL and OAuth settings |
| Local Streamable HTTP  | A local MCP HTTP client or integration test                             | The loopback HTTP launcher settings   |

The default package and plugin modes are credential-free, use the deterministic
demo runner, and listen only on loopback. Production or hosted operation must
provide authentication, TLS, workspace scoping, and a separately managed
provider secret boundary.

## Hosted GitHub App boundary

Hosted GitHub App ingress is disabled by default. Enabling the bounded hosted
path requires all of the following:

- `EVENTFORGE_GITHUB_APP_ENABLED=true`
- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`
- a server-side installation registry injected into the control plane

The boundary accepts only signed GitHub Cloud `check_run`, `issues`, and
`pull_request` deliveries with a delivery identifier. Installation and
repository claims are checked against the attested server-side mapping before
tenant data is created.

Installations require:

- an Owner/Admin MFA session and ten-minute single-use state nonce
- explicit confirmation after every installation or reinstallation
- exact read-only Checks, Issues, and Pull requests permissions
- a workspace retention-policy link that remains after uninstall

Suspended, removed, unconfirmed, out-of-scope, and archived repositories cannot
create an investigation. GitHub text and logs remain untrusted evidence, and the
hosted path cannot create a GitHub write proposal. Local GitHub relay operation
remains credential-free and unchanged.

This switch is a fail-closed foundation gate, not a production-readiness claim.
Keep it disabled until the durable installation store, GitHub API attestor,
callback/confirmation routes, lifecycle reconciliation, credential cleanup,
support runbook, and security release gates are complete.

## Zero-checkout stdio (recommended)

Requirements: Node.js 20.11 or newer and a Codex CLI with MCP support.

Run this from the project whose files EventForge should inspect:

```bash
codex mcp add eventforge \
  --env EVENTFORGE_CODEX_WORKDIR="$PWD" \
  -- npx -y --package github:sinequix/eventforge eventforge-mcp
```

Restart Codex and verify the server:

```bash
codex mcp list
```

The launcher downloads a self-contained bundle, starts an embedded API at
`http://127.0.0.1:4310` if one is not already healthy, and exposes the nine
EventForge tools over stdio. No repository checkout, database, Cloudflare
account, or provider credential is required for the demo path.

To use an existing local API instead of starting one automatically:

```bash
codex mcp add eventforge \
  --env EVENTFORGE_API_URL="http://127.0.0.1:4310" \
  --env EVENTFORGE_AUTO_START=false \
  --env EVENTFORGE_CODEX_WORKDIR="$PWD" \
  -- npx -y --package github:sinequix/eventforge eventforge-mcp
```

The GitHub package spec is the supported public installer until
`@eventforge/mcp-server` is published to npm. After publication, use:

```bash
codex mcp add eventforge \
  --env EVENTFORGE_CODEX_WORKDIR="$PWD" \
  -- npx -y @eventforge/mcp-server
```

## Codex TOML configuration

The equivalent `~/.codex/config.toml` entry is:

```toml
[mcp_servers.eventforge]
command = "npx"
args = ["-y", "--package", "github:sinequix/eventforge", "eventforge-mcp"]
startup_timeout_sec = 20
tool_timeout_sec = 60

env = {
  EVENTFORGE_CODEX_WORKDIR = "/absolute/path/to/project",
  EVENTFORGE_DEMO_MODE = "true",
  EVENTFORGE_RUNNER = "demo",
}
```

Do not put API keys, provider secrets, or tunnel tokens in this file. Use the
Codex environment indirection or the host's secret manager for sensitive values.

## Native Codex plugin

From a repository checkout:

```bash
codex plugin marketplace add .
codex plugin add eventforge@eventforge-local
```

The plugin's MCP registration uses the bundled self-starting launcher, so a
separate `pnpm dev` process is optional. Review and trust the optional
health-only session hook separately. To point the plugin at an existing API,
set `EVENTFORGE_API_URL` and `EVENTFORGE_AUTO_START=false` in the plugin
environment, then restart Codex.

## Repository development

```bash
corepack enable && corepack prepare pnpm@11.5.1 --activate
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

In another terminal, start the console:

```bash
pnpm dev:console
```

Verify the API and console configuration:

```bash
curl --fail http://127.0.0.1:4310/health
open http://localhost:5173
```

The browser origin must exactly match `EVENTFORGE_ALLOWED_ORIGINS`. The local
default is `http://localhost:5173`; do not use `*` for a credentialed console.

## Local Streamable HTTP

The HTTP launcher is useful for local clients that cannot use stdio:

```bash
npx -y --package github:sinequix/eventforge eventforge-mcp-http
```

It serves `http://127.0.0.1:4312/mcp` and starts the local API automatically.
For a fixed local bearer token, set `EVENTFORGE_MCP_BEARER_TOKEN` in the
launcher environment. This token is only a loopback convenience and is not a
replacement for OAuth.

```toml
[mcp_servers.eventforge_local_http]
url = "http://127.0.0.1:4312/mcp"
bearer_token_env_var = "EVENTFORGE_MCP_BEARER_TOKEN"
```

The launcher refuses `0.0.0.0`, LAN addresses, and public hostnames. Never
disable this check to expose a local process to the internet.

## Remote Streamable HTTP

For a hosted or private deployment, the MCP URL must be HTTPS and terminate at
EventForge's OAuth 2.1 authorization layer. P0 supports only provisioned
first-party Codex clients using Authorization Code + S256 PKCE. The only OAuth
scopes are `eventforge:read` (events and workflow state) and
`eventforge:review` (investigation/proposal details); neither permits actions,
approvals, installation, or connector changes. OAuth establishes visibility and
never replaces policy or approval checks.

```bash
codex mcp add eventforge-remote --url https://mcp.example.com/mcp
codex mcp login eventforge-remote
```

The equivalent configuration is:

```toml
[mcp_servers.eventforge_remote]
url = "https://mcp.example.com/mcp"
auth = "oauth"
startup_timeout_sec = 20
tool_timeout_sec = 60
default_tools_approval_mode = "writes"
```

The public `eventforge.dev` console and API are not interchangeable with an
MCP endpoint. The URL must point to a server exposing the MCP `/mcp` route.

Remote production remains disabled until a durable grant repository, the live
session/token authority, security testing, and deployment configuration are
complete. Refresh-token compromise response: revoke the affected client grant
family for that workspace, remove/role-reduce the member if appropriate, and
review the tenant-scoped `refresh_reuse` security event. DPoP is deferred, so
bearer-token replay remains a documented residual risk. An external penetration
test is a release gate before enabling remote MCP.

## Environment variable reference

## Operational readiness (foundation)

`apps/control-plane/src/operational-readiness.ts` contains fail-closed contracts and defaults, while `operational-readiness-postgres.ts` provides the durable PostgreSQL adapter. Neither file enables a hosted monitor. Runtime wiring must supply a trusted server-side operator authorization resolver; callers pass an opaque authenticated session reference, never roles or approval booleans. Probes are specified every five minutes against non-sensitive synthetic tenants. Customer-impacting failures target ten-minute routing; authentication, tenancy, unsigned ingress, kill-switch bypass, and data-integrity failures target immediate routing. Poison work routes no later than five minutes after retry exhaustion and alert-provider outage requires an independent fallback signal. See `workfiles/OPERATIONAL_READINESS.md` for runbooks and the explicit evidence boundary.

## Hosted billing (not enabled by this repository)

Hosted billing remains fail-closed until a separately authenticated remote host
supplies a least-privilege Stripe restricted key, webhook signing secret, and
externally configured recurring USD Price ids for the separate Team and Business
Products. Never put these values in repository configuration, browser variables,
or local demo files. Tax is disabled until active registrations and a canonical
tax code/configuration have been confirmed; a missing tax configuration is a
visible deployment blocker, not a zero-tax fallback.

### MCP client and launcher

| Variable                      | Default                       | Meaning                                                  |
| ----------------------------- | ----------------------------- | -------------------------------------------------------- |
| `EVENTFORGE_API_URL`          | `http://127.0.0.1:4310`       | API used by the MCP server                               |
| `EVENTFORGE_AUTO_START`       | `true` for standalone bundles | Start an embedded loopback API when the URL is unhealthy |
| `EVENTFORGE_CODEX_WORKDIR`    | Current directory             | Repository/workspace available to local Codex workflows  |
| `EVENTFORGE_API_TOKEN`        | Empty                         | Bearer token for an authenticated API                    |
| `EVENTFORGE_MCP_HOST`         | `127.0.0.1`                   | HTTP MCP bind host; must remain loopback locally         |
| `EVENTFORGE_MCP_PORT`         | `4312`                        | HTTP MCP bind port                                       |
| `EVENTFORGE_MCP_BEARER_TOKEN` | Empty                         | Optional loopback HTTP bearer token                      |
| `EVENTFORGE_DEMO_MODE`        | `true` in standalone mode     | Enables deterministic provider fixtures                  |
| `EVENTFORGE_RUNNER`           | `demo` in standalone mode     | `demo` or the explicitly configured Codex runner         |

### Local control plane and console

| Variable                     | Meaning                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `PORT`                       | Fastify API port; normally `4310`                                                               |
| `EVENTFORGE_RUNTIME_MODE`    | `local` for the supported local path                                                            |
| `EVENTFORGE_PUBLIC_URL`      | Public/base URL used by local integrations                                                      |
| `EVENTFORGE_ALLOWED_ORIGINS` | Exact comma-separated browser origins                                                           |
| `EVENTFORGE_ENCRYPTION_KEY`  | Local secret used for protected state; keep it outside Git                                      |
| `DATABASE_URL`               | Optional PostgreSQL connection for local/private deployments                                    |
| `VITE_EVENTFORGE_API_URL`    | Console build-time API URL                                                                      |
| `VITE_WAITLIST_API_URL`      | Optional waitlist API override; production defaults to `https://api.eventforge.dev/v1/waitlist` |
| `VITE_POSTHOG_KEY`           | Public PostHog project API key for anonymous product events                                     |
| `VITE_POSTHOG_HOST`          | PostHog capture host; default `https://us.i.posthog.com`                                        |
| `VITE_GA_MEASUREMENT_ID`     | GA4 web stream Measurement ID, normally `G-XXXXXXXXXX`                                          |

### Concealed waitlist and analytics

The public landing page does not advertise the waitlist in its navigation. The
direct route is:

```text
https://eventforge.dev/waitlist
```

The form posts only a normalized email, source, and consent timestamp to the
public Cloudflare API surface at `/v1/waitlist`. It uses a honeypot,
exact-origin CORS, D1 uniqueness, and a five-submissions-per-IP-per-hour
limit. Emails are stored in the production `eventforge-control` D1 database;
payloads are never accepted by this route.

Production is configured through the public runtime file
`apps/console/public/analytics-config.json`, with the GA4 fallback tracked in
`apps/console/.env.production` so every production build remains tagged. These
are public project identifiers, not secret credentials. For a different project
or preview environment, override the values before building the console:

```bash
export VITE_POSTHOG_KEY="phc_..."
export VITE_POSTHOG_HOST="https://us.i.posthog.com"
export VITE_GA_MEASUREMENT_ID="G-XXXXXXXXXX"
pnpm --filter @eventforge/console deploy:cloudflare
```

EventForge emits anonymous `page_view`, `waitlist_submit_started`,
`waitlist_submitted`, and `waitlist_submit_failed` events. Email addresses and
form payloads are never sent to PostHog or Google Analytics. Create the
PostHog project and GA4 web stream in their respective accounts, then update
the public runtime IDs or provide replacement build-time IDs. Keep all private
credentials outside source control and the browser bundle.

The API worker's D1 migration and rate-limit secret are provisioned with:

```bash
npx wrangler d1 migrations apply eventforge-control-production --remote \
  --config apps/cloudflare/wrangler.jsonc --env production
openssl rand -base64 32 | npx wrangler secret put WAITLIST_RATE_LIMIT_SECRET \
  --config apps/cloudflare/wrangler.jsonc --env production
```

### Provider and relay settings

Provider secrets are only needed for live provider traffic. Demo events do not
need them. For GitHub relay development, `gh` must be authenticated and
`cloudflared` must be installed.

| Variable                                                                      | Meaning                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `GITHUB_WEBHOOK_SECRET`                                                       | GitHub signature verification secret                         |
| `LINEAR_WEBHOOK_SECRET`                                                       | Linear signature verification secret                         |
| `SENTRY_WEBHOOK_SECRET`                                                       | Sentry signature verification secret                         |
| `EVENTFORGE_GITHUB_REPOSITORY`                                                | Explicit `OWNER/REPOSITORY` when auto-detection is ambiguous |
| `EVENTFORGE_CLOUDFLARED_BIN`                                                  | Cloudflared executable path                                  |
| `EVENTFORGE_CLOUDFLARED_TUNNEL` / `EVENTFORGE_CLOUDFLARED_PUBLIC_URL`         | Pair for a pre-created named tunnel                          |
| `EVENTFORGE_TUNNEL_PROVISIONING_URL` / `EVENTFORGE_TUNNEL_PROVISIONING_TOKEN` | Pair for authenticated hosted tunnel provisioning            |

Cloudflare account credentials (`CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN`, and
`EVENTFORGE_TUNNEL_NAMING_KEY`) belong only on the authenticated hosted control
plane. Never copy them into Codex, the MCP client, or a browser variable.

## Configuration precedence and safety

1. Explicit process environment supplied by Codex or the shell.
2. `.env` loaded by the repository control-plane process.
3. Launcher defaults shown above.

The MCP package does not read `.env` from an arbitrary remote project. Set
launcher variables explicitly in Codex when using zero-checkout mode. The
standalone launcher only auto-starts `http://` loopback URLs; HTTPS, non-loopback
hosts, invalid ports, and remote HTTP bindings fail closed.

## Verification checklist

After any configuration change:

```bash
codex mcp list
curl --fail http://127.0.0.1:4310/health
pnpm --filter @eventforge/mcp-server pack:check
pnpm plugin:check
```

For a release-quality verification from a clean checkout, run:

```bash
pnpm quality
```

A successful MCP connection must expose these tools:

`listen_for_webhook`, `emit_event`, `query_memory`, `spawn_subagent`,
`approve_action`, `forge_mcp`, `approve_forge`, `list_events`, and
`list_workflows`.

## Remove or reset a configuration

```bash
codex mcp remove eventforge
```

Then remove any matching `mcp_servers.eventforge` block from
`~/.codex/config.toml`. Removing the MCP registration does not delete local
EventForge data or provider webhooks; clean those up separately when using the
GitHub relay.
