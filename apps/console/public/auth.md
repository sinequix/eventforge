# Auth.md — EventForge authentication

EventForge's public product documentation and discovery resources are available without credentials. The hosted console and operational API require an authenticated, workspace-scoped identity before they expose tenant data or allow mutations.

## Agent registration

For hosted access, use the OAuth 2.1 discovery metadata at https://eventforge.dev/.well-known/openid-configuration when OAuth access is enabled for your workspace. The hosted remote MCP endpoint is currently gated while authentication and tenant isolation complete their release gates.

For an immediately usable agent client, install the credential-free local MCP transport:

```bash
codex mcp add eventforge -- npx -y --package github:sinequix/eventforge eventforge-mcp
```

The machine-readable client manifest is available at https://eventforge.dev/.well-known/agent-client.json. It includes the stdio command and the loopback Streamable HTTP alternative.

The machine-readable registration contract is:

```yaml
agent_auth:
  register_uri: https://api.eventforge.dev/oauth/register
  identity_types: [user, service]
  credential_types: [oauth2-bearer, api-key]
  claims: [sub, workspace_id, scopes]
  revocation_uri: https://api.eventforge.dev/oauth/revoke
```

## Safety boundary

The public webhook ingress accepts only provider-signed events. Console routes remain sign-in gated, and reaction operations require scoped authorization and approval according to the workspace policy.
