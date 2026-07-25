interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: AssetsBinding;
  // Pre-production only. When set, /api/* is proxied here so the browser sees a
  // same-origin request and the session cookie can stay SameSite=Strict.
  API_ORIGIN?: string;
}

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export function isConsolePath(pathname: string): boolean {
  return pathname === "/console" || pathname.startsWith("/console/");
}

const agentMarkdown = `# EventForge

EventForge is the operational control plane for every hook, from receipt to verified outcome.

## Public resources

- Product overview: https://eventforge.dev/
- Configuration guide: https://github.com/tebayoso/eventforge/blob/main/workfiles/CONFIGURATION.md
- Source repository: https://github.com/tebayoso/eventforge
- API catalog: https://eventforge.dev/.well-known/api-catalog
- MCP server card: https://eventforge.dev/.well-known/mcp/server-card.json
- Agent client manifest: https://eventforge.dev/.well-known/agent-client.json
- Agent Skills index: https://eventforge.dev/.well-known/agent-skills/index.json

## Operating surfaces

EventForge provides a local, credential-free MCP server for development and a hosted API for authenticated production operations. The local launcher is installed with:

codex mcp add eventforge -- npx -y --package github:tebayoso/eventforge eventforge-mcp

The hosted console and remote MCP transport are intentionally sign-in gated. Public pages and discovery metadata contain no customer payloads or secrets.
`;

const robotsTxt = `User-agent: *
Allow: /
Disallow: /console
Disallow: /api

User-agent: GPTBot
Allow: /
Disallow: /console
Disallow: /api

User-agent: OAI-SearchBot
Allow: /
Disallow: /console
Disallow: /api

User-agent: Claude-Web
Allow: /
Disallow: /console
Disallow: /api

User-agent: Google-Extended
Allow: /
Disallow: /console
Disallow: /api

Content-Signal: ai-train=no, search=yes, ai-input=yes
Sitemap: https://eventforge.dev/sitemap.xml
`;

const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://eventforge.dev/</loc>
    <changefreq>weekly</changefreq>
  </url>
  <url>
    <loc>https://eventforge.dev/features</loc>
    <changefreq>weekly</changefreq>
  </url>
</urlset>
`;

const oauthAuthorizationServer = JSON.stringify({
  issuer: "https://eventforge.dev",
  authorization_endpoint: "https://api.eventforge.dev/oauth/authorize",
  token_endpoint: "https://api.eventforge.dev/oauth/token",
  jwks_uri: "https://api.eventforge.dev/.well-known/jwks.json",
  grant_types_supported: ["authorization_code", "refresh_token"],
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["eventforge:read", "eventforge:operate", "eventforge:approve"],
  agent_auth: {
    skill: "https://eventforge.dev/auth.md",
    register_uri: "https://api.eventforge.dev/oauth/register",
    identity_types_supported: ["user", "service", "anonymous"],
    credential_types_supported: ["oauth2-bearer", "api-key"],
    claims_supported: ["sub", "workspace_id", "scopes"],
    claim_uri: "https://api.eventforge.dev/oauth/claims",
    revocation_uri: "https://api.eventforge.dev/oauth/revoke",
    anonymous: {
      credential_types_supported: ["api-key"],
      claim_uri: "https://api.eventforge.dev/oauth/claims",
    },
    registration_methods: [
      {
        type: "oauth2-authorization-code",
        register_uri: "https://api.eventforge.dev/oauth/register",
        identity_type: "service",
        credential_type: "oauth2-bearer",
        token_endpoint: "https://api.eventforge.dev/oauth/token",
      },
      {
        type: "api-key",
        register_uri: "https://api.eventforge.dev/oauth/register",
        identity_type: "service",
        credential_type: "api-key",
      },
    ],
  },
});

const homepageLinks = [
  '<https://eventforge.dev/sitemap.xml>; rel="sitemap"',
  '<https://eventforge.dev/.well-known/api-catalog>; rel="service-desc"; type="application/linkset+json"',
  '<https://github.com/tebayoso/eventforge/blob/main/workfiles/CONFIGURATION.md>; rel="service-doc"; type="text/markdown"',
  '<https://api.eventforge.dev/health>; rel="status"',
].join(", ");

function markdownResponse(): Response {
  return new Response(agentMarkdown, {
    headers: {
      ...securityHeaders,
      "cache-control": "public, max-age=300",
      "content-type": "text/markdown; charset=utf-8",
      link: homepageLinks,
    },
  });
}

function gatedConsole(): Response {
  return new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EventForge sign-in required</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e13;color:#f4f5f7;font:16px/1.5 system-ui,sans-serif}main{max-width:38rem;padding:2rem}p{color:#aab2c0}a{color:#8ee5c2}</style><main><p>EventForge secure console</p><h1>Sign-in is not enabled yet.</h1><p>The hosted console is closed until account authentication and tenant isolation pass their release gates.</p><a href="/">Return to EventForge</a></main></html>',
    {
      status: 503,
      headers: { ...securityHeaders, "content-type": "text/html; charset=utf-8" },
    },
  );
}

// Analytics config is a static asset, so a build that forgot to blank it — or a
// manual `wrangler deploy --env beta` that skipped the beta build script — would
// ship the production PostHog key and GA4 id to a pre-production host. That
// happened twice, so the guarantee now lives here, where no build step can
// bypass it: any non-production hostname gets a blanked config regardless of what
// is sitting in dist/.
export function isPreProductionHost(hostname: string): boolean {
  return hostname !== "eventforge.dev" && hostname !== "www.eventforge.dev";
}

const disabledAnalyticsConfig = JSON.stringify({
  posthogKey: "",
  posthogHost: "",
  gaMeasurementId: "",
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Same-origin proxy for the auth/API surface. Keeping this on the console
    // origin is what lets the session cookie be SameSite=Strict instead of a
    // cross-site None cookie.
    if (url.pathname.startsWith("/api/") && isPreProductionHost(url.hostname) && env.API_ORIGIN) {
      const upstream = new URL(url.pathname + url.search, env.API_ORIGIN);
      const proxied = new Request(upstream, request);
      proxied.headers.set("x-forwarded-host", url.hostname);
      return fetch(proxied);
    }

    // The hosted console is open on pre-production hosts only. Production stays
    // closed until hosted auth passes its own release gates.
    if (isConsolePath(url.pathname)) {
      if (!isPreProductionHost(url.hostname)) return gatedConsole();
      // Pass the original request: `not_found_handling: single-page-application`
      // serves index.html for /console. Fetching /index.html directly would be
      // redirected to / by the assets binding.
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/analytics-config.json" && isPreProductionHost(url.hostname)) {
      return new Response(disabledAnalyticsConfig, {
        headers: {
          ...securityHeaders,
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        },
      });
    }

    if (url.pathname === "/robots.txt") {
      return new Response(robotsTxt, {
        headers: {
          ...securityHeaders,
          "cache-control": "public, max-age=300",
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }
    if (["/sitemap.xml", "/sitemap-index.xml", "/sitemap_index.xml"].includes(url.pathname)) {
      return new Response(sitemapXml, {
        headers: {
          ...securityHeaders,
          "cache-control": "public, max-age=300",
          "content-type": "application/xml; charset=utf-8",
        },
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return new Response(oauthAuthorizationServer, {
        headers: {
          ...securityHeaders,
          "cache-control": "public, max-age=300",
          "content-type": "application/json; charset=utf-8",
        },
      });
    }

    if (url.pathname === "/" && request.headers.get("accept")?.includes("text/markdown")) {
      return markdownResponse();
    }

    const response = await env.ASSETS.fetch(request);
    if (
      url.pathname !== "/" &&
      url.pathname !== "/.well-known/api-catalog" &&
      url.pathname !== "/.well-known/openid-configuration" &&
      url.pathname !== "/.well-known/oauth-authorization-server" &&
      url.pathname !== "/.well-known/oauth-protected-resource" &&
      url.pathname !== "/waitlist"
    ) {
      return response;
    }

    const headers = new Headers(response.headers);
    if (url.pathname === "/waitlist") {
      headers.set("x-robots-tag", "noindex, nofollow, noarchive");
      headers.set("cache-control", "no-store");
    }
    if (url.pathname === "/") headers.set("link", homepageLinks);
    if (url.pathname === "/.well-known/api-catalog") {
      headers.set("content-type", "application/linkset+json; charset=utf-8");
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      headers.set("content-type", "application/json; charset=utf-8");
    }
    if (url.pathname === "/.well-known/openid-configuration") {
      headers.set("content-type", "application/json; charset=utf-8");
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      headers.set("content-type", "application/json; charset=utf-8");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
