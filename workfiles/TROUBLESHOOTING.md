# EventForge Troubleshooting

Start with the [configuration guide](CONFIGURATION.md) to confirm that the
selected MCP mode, URL, environment, and authentication boundary match the
process you are actually running.

## Corepack is not installed

The repository pins pnpm 11.5.1. Node.js 22–24 normally expose Corepack, while Node.js 25 and newer no longer bundle it. If `corepack enable` is unavailable, install the pinned package manager directly:

```bash
npm install --global pnpm@11.5.1
pnpm --version
```

Continue only when `pnpm --version` reports `11.5.1`.

## Console reports offline or degraded

1. Check `curl http://127.0.0.1:4310/health`.
2. Start the control plane with `pnpm dev` and the console in a second terminal with `pnpm dev:console`.
3. Confirm `VITE_EVENTFORGE_API_URL` points to the intended API and that `EVENTFORGE_ALLOWED_ORIGINS` includes the exact browser origin.
4. A failed resource request must remain visible as degraded; do not interpret an empty panel as proof that no events or approvals exist.
5. If the API reports `429`, check `EVENTFORGE_RATE_LIMIT_PER_MINUTE`. Local mode defaults high enough for dashboard polling; remote mode intentionally keeps the stricter default.

## EventForge MCP tools are missing

1. Run `codex mcp list` and confirm the server name and command/URL.
2. For package mode, run `npx -y --package github:sinequix/eventforge eventforge-mcp` from a terminal and confirm the embedded API starts on loopback.
3. Run `pnpm --filter @eventforge/mcp-server pack:check` and `pnpm plugin:check` from a checkout.
4. Review the plugin's `.mcp.json` and `.codex-plugin/plugin.json` paths.
5. Restart Codex after installing or changing a plugin. Plugin-bundled hooks require a separate trust review when their content changes.

## MCP HTTP connection fails

- A local HTTP launcher must use `http://127.0.0.1:4312/mcp` by default.
- A remote URL must be HTTPS and terminate at OAuth 2.1 or an OAuth-aware proxy.
- `EVENTFORGE_MCP_HOST=0.0.0.0` and other non-loopback bindings intentionally fail closed.
- `eventforge.dev`, `api.eventforge.dev`, and `hooks.eventforge.dev` are not automatically MCP endpoints; use the URL supplied by the MCP host administrator.
- If Codex uses OAuth, run `codex mcp login <server-name>` and restart the connection.

## A live webhook is rejected

- Verify the provider uses the matching signing secret and sends the original raw JSON body.
- GitHub signatures include the `sha256=` prefix; Linear and Sentry signatures are bare hexadecimal digests.
- Linear and Sentry timestamps outside their configured replay window are rejected.
- In remote foundation tests, confirm the injected provider delivery/installation mapping selects the expected workspace, project, and repository. Local GitHub mode uses its configured repository.

## GitHub local tunnel does not start

- Install `cloudflared` and authenticate the `gh` CLI for the target repository.
- Set `EVENTFORGE_GITHUB_REPOSITORY=OWNER/REPOSITORY` when automatic detection is ambiguous.
- Quick Tunnels are temporary and receive a new URL on each launch; EventForge patches its single managed repository webhook.
- For managed `*.eventforge.dev` relays, configure both `EVENTFORGE_TUNNEL_PROVISIONING_URL` and `EVENTFORGE_TUNNEL_PROVISIONING_TOKEN` locally. Configure `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN`, and `EVENTFORGE_TUNNEL_NAMING_KEY` only on the authenticated hosted control plane.
- A `503` from `/tunnels/provision` means hosted provisioning is intentionally disabled. A `401`/`403` means the session lacks authenticated owner identity or `eventforge:install` scope. Do not copy an account-wide Cloudflare token into the local MCP environment.
- Do not reuse Quick Tunnels for production traffic.

## Docker Compose configuration fails

Run `docker compose config --quiet` before starting services. The default stack does not require a Cloudflare token. `CLOUDFLARE_TUNNEL_TOKEN` is required only when enabling `--profile cloudflare-tunnel`.

## Remote mode refuses to start

This is intentional when the production safety boundary is incomplete. Remote mode requires PostgreSQL, an encryption key, explicit browser origins, and a configured authenticator. Do not bypass startup validation or substitute CORS for authentication.

## Electron packaging fails

Run the console build before the desktop package command. Confirm the desktop build contains compiled `dist/main.js` and `dist/preload.js`, and that the packaged resources contain the console `index.html`. Signing/notarization credentials are external release secrets and are not stored in the repository.
