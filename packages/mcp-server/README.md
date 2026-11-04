# EventForge MCP server

The EventForge MCP server exposes policy-gated event, memory, agent-run, approval, and connector-forging tools to Codex.

See the repository's [canonical configuration guide](../../workfiles/CONFIGURATION.md)
for zero-checkout stdio, Codex TOML, local HTTP, remote OAuth HTTP, environment
variables, and verification steps.

The package can self-start a credential-free local control plane when launched as `eventforge-mcp`. From Codex, use the public repository before the npm release:

```bash
codex mcp add eventforge -- npx -y --package github:sinequix/eventforge eventforge-mcp
```

After the scoped package is published, replace the package spec with `@eventforge/mcp-server`. From this repository, validate the publishable tarball with `pnpm pack:check`.

The standalone stdio transport starts a local EventForge control plane automatically at `http://127.0.0.1:4310` when no API is already available. Override it with `EVENTFORGE_API_URL`; set `EVENTFORGE_AUTO_START=false` to use the package only as an MCP adapter.

An opt-in Streamable HTTP transport is available as `eventforge-mcp-http`. It starts the same local control plane when no local API is reachable, then serves `/mcp` on `127.0.0.1:4312` by default so it does not collide with Electron's local-memory daemon on port 4311. Override the loopback host/port with `EVENTFORGE_MCP_HOST` and `EVENTFORGE_MCP_PORT`; `EVENTFORGE_MCP_BEARER_TOKEN` may protect loopback access. Non-loopback binding fails closed until EventForge's OAuth 2.1 authorization layer is available; a static token never enables remote access. Put this launcher behind an OAuth-aware TLS proxy for a remote Codex URL.

The launcher honors `EVENTFORGE_API_URL`, `EVENTFORGE_AUTO_START=false`, `EVENTFORGE_CODEX_WORKDIR`, `EVENTFORGE_DEMO_MODE`, and `EVENTFORGE_RUNNER`. It uses demo mode by default so package installation does not require provider credentials or an OpenAI key.
