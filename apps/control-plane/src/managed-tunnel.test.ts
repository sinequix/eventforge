import { describe, expect, it, vi } from "vitest";
import {
  CloudflareManagedTunnelProvisioner,
  createTunnelProvisionerFromEnv,
  threeWordTunnelSlug,
  validateLocalTunnelOrigin,
} from "./managed-tunnel.js";

const tunnelId = "f2b4017c-f521-4f96-b2be-945897607b9d";
const tunnelToken = "tunnel-token-that-is-longer-than-thirty-two-characters";
const cfResponse = (result: unknown, status = 200, success = true) =>
  new Response(
    JSON.stringify({
      success,
      result,
      errors: success ? [] : [{ code: 1000, message: "denied" }],
    }),
    { status, headers: { "content-type": "application/json" } },
  );

describe("managed Cloudflare tunnel provisioning", () => {
  it("derives a stable, valid three-word hostname per actor and workspace", () => {
    const first = threeWordTunnelSlug("actor-1", "workspace-1", "a-secure-naming-key");
    expect(first).toMatch(/^[a-z]{6}-[a-z]{6}-[a-z]{6}$/);
    expect(threeWordTunnelSlug("actor-1", "workspace-1", "a-secure-naming-key")).toBe(first);
    expect(threeWordTunnelSlug("actor-2", "workspace-1", "a-secure-naming-key")).not.toBe(first);
    expect(() => threeWordTunnelSlug("actor", "workspace", "short")).toThrow("16");
  });

  it("allows only a pathless HTTP loopback origin", () => {
    expect(validateLocalTunnelOrigin("http://127.0.0.1:4310")).toBe("http://127.0.0.1:4310");
    expect(validateLocalTunnelOrigin("http://[::1]:4310")).toBe("http://[::1]:4310");
    for (const value of [
      "https://127.0.0.1:4310",
      "http://example.com:4310",
      "http://user:pass@localhost:4310",
      "http://localhost:4310/private",
    ]) {
      expect(() => validateLocalTunnelOrigin(value)).toThrow("loopback");
    }
  });

  it("creates, configures, routes, and returns only a tunnel-scoped credential", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(cfResponse([]))
      .mockResolvedValueOnce(cfResponse({ id: tunnelId, name: "eventforge-test" }))
      .mockResolvedValueOnce(cfResponse({}))
      .mockResolvedValueOnce(cfResponse([]))
      .mockResolvedValueOnce(cfResponse({ id: "dns-1" }))
      .mockResolvedValueOnce(cfResponse(tunnelToken));
    const provisioner = new CloudflareManagedTunnelProvisioner({
      accountId: "account-1",
      zoneId: "zone-1",
      apiToken: "account-token",
      namingKey: "a-secure-naming-key",
      fetchImpl,
    });
    const lease = await provisioner.provision({
      actorId: "owner-1",
      workspaceId: "workspace-1",
      originUrl: "http://127.0.0.1:4310",
    });
    expect(lease).toMatchObject({
      tunnelId,
      publicUrl: `https://${lease.hostname}`,
      token: tunnelToken,
    });
    expect(lease.hostname).toMatch(/^[a-z]{6}-[a-z]{6}-[a-z]{6}\.eventforge\.dev$/);
    const requests = fetchImpl.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }));
    expect(requests.map(({ method }) => method)).toEqual([
      "GET",
      "POST",
      "PUT",
      "GET",
      "POST",
      "GET",
    ]);
    expect(requests[2]?.body.config.ingress).toEqual([
      {
        hostname: lease.hostname,
        path: "^/webhooks/(github|linear|sentry)$",
        service: "http://127.0.0.1:4310",
      },
      {
        hostname: lease.hostname,
        path: "^/health$",
        service: "http://127.0.0.1:4310",
      },
      { service: "http_status:404" },
    ]);
    expect(requests[4]?.body.content).toBe(`${tunnelId}.cfargotunnel.com`);
    expect(String(fetchImpl.mock.calls[0]?.[1]?.headers)).not.toContain(tunnelToken);
  });

  it("reuses the actor's tunnel and does not rewrite a correct DNS record", async () => {
    const slug = threeWordTunnelSlug("owner-1", "workspace-1", "a-secure-naming-key");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(cfResponse([{ id: tunnelId, name: `eventforge-${slug}` }]))
      .mockResolvedValueOnce(cfResponse({}))
      .mockResolvedValueOnce(
        cfResponse([
          {
            id: "dns-1",
            name: `${slug}.eventforge.dev`,
            content: `${tunnelId}.cfargotunnel.com`,
          },
        ]),
      )
      .mockResolvedValueOnce(cfResponse(tunnelToken));
    const provisioner = new CloudflareManagedTunnelProvisioner({
      accountId: "account-1",
      zoneId: "zone-1",
      apiToken: "account-token",
      namingKey: "a-secure-naming-key",
      fetchImpl,
    });
    const lease = await provisioner.provision({
      actorId: "owner-1",
      workspaceId: "workspace-1",
      originUrl: "http://localhost:4310",
    });
    expect(lease.tunnelName).toBe(`eventforge-${slug}`);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("rolls back a newly created tunnel when configuration fails", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(cfResponse([]))
      .mockResolvedValueOnce(cfResponse({ id: tunnelId, name: "eventforge-test" }))
      .mockResolvedValueOnce(cfResponse(undefined, 403, false))
      .mockResolvedValueOnce(cfResponse({}));
    const provisioner = new CloudflareManagedTunnelProvisioner({
      accountId: "account-1",
      zoneId: "zone-1",
      apiToken: "account-token",
      namingKey: "a-secure-naming-key",
      fetchImpl,
    });
    await expect(
      provisioner.provision({
        actorId: "owner-1",
        workspaceId: "workspace-1",
        originUrl: "http://127.0.0.1:4310",
      }),
    ).rejects.toThrow("denied");
    expect(fetchImpl.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  });

  it("fails loudly when only part of the server-side Cloudflare config exists", () => {
    expect(createTunnelProvisionerFromEnv({})).toBeUndefined();
    const warnings: string[] = [];
    expect(
      createTunnelProvisionerFromEnv({ CLOUDFLARE_ACCOUNT_ID: "account-1" }, (m) =>
        warnings.push(m),
      ),
    ).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("degrades to no provisioning when only a stray Cloudflare API token is set", () => {
    const warnings: string[] = [];
    const secret = "wrangler-token-value-that-must-not-leak";
    expect(
      createTunnelProvisionerFromEnv({ CLOUDFLARE_API_TOKEN: secret }, (m) => warnings.push(m)),
    ).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("disabled");
    expect(warnings[0]).toContain("EVENTFORGE_TUNNEL_NAMING_KEY");
    expect(warnings[0]).not.toContain(secret);
  });

  it("degrades when all Cloudflare variables are set but the EventForge naming key is not", () => {
    const warnings: string[] = [];
    expect(
      createTunnelProvisionerFromEnv(
        { CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_ZONE_ID: "z", CLOUDFLARE_API_TOKEN: "t" },
        (m) => warnings.push(m),
      ),
    ).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("throws when an EventForge tunnel variable shows intent but required ones are missing", () => {
    const warn = () => {
      throw new Error("must not warn");
    };
    expect(() =>
      createTunnelProvisionerFromEnv({ EVENTFORGE_TUNNEL_NAMING_KEY: "k" }, warn),
    ).toThrow("CLOUDFLARE_ZONE_ID");
    expect(() =>
      createTunnelProvisionerFromEnv(
        { EVENTFORGE_TUNNEL_BASE_DOMAIN: "tunnels.example.com", CLOUDFLARE_API_TOKEN: "t" },
        warn,
      ),
    ).toThrow("EVENTFORGE_TUNNEL_NAMING_KEY");
  });

  it("builds a provisioner when every variable is set", () => {
    expect(
      createTunnelProvisionerFromEnv({
        CLOUDFLARE_ACCOUNT_ID: "a",
        CLOUDFLARE_ZONE_ID: "z",
        CLOUDFLARE_API_TOKEN: "t",
        EVENTFORGE_TUNNEL_NAMING_KEY: "k",
      }),
    ).toBeDefined();
  });
});
