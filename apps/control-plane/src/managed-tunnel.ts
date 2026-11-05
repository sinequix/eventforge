import { createHmac } from "node:crypto";
import { ManagedTunnelLeaseSchema, type ManagedTunnelLease } from "@eventforge/core";

const CONSONANTS = "bcdfghjklmnpqrstvwxyz";
const VOWELS = "aeiou";
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export type TunnelProvisionInput = {
  actorId: string;
  workspaceId: string;
  originUrl: string;
};

export interface TunnelProvisioner {
  provision(input: TunnelProvisionInput): Promise<ManagedTunnelLease>;
}

type CloudflareEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
};

type CloudflareTunnel = { id: string; name: string };
type CloudflareDnsRecord = { id: string; name: string; content: string };

function pronounceableWord(bytes: Uint8Array): string {
  return Array.from(bytes, (byte, index) => {
    const alphabet = index % 2 === 0 ? CONSONANTS : VOWELS;
    return alphabet[byte % alphabet.length];
  }).join("");
}

export function threeWordTunnelSlug(
  actorId: string,
  workspaceId: string,
  namingKey: string,
): string {
  if (namingKey.length < 16)
    throw new Error("Tunnel naming key must contain at least 16 characters.");
  const digest = createHmac("sha256", namingKey).update(`${workspaceId}\0${actorId}`).digest();
  return [0, 6, 12]
    .map((offset) => pronounceableWord(digest.subarray(offset, offset + 6)))
    .join("-");
}

export function validateLocalTunnelOrigin(value: string): string {
  const url = new URL(value);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  if (
    url.protocol !== "http:" ||
    !loopbackHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Managed tunnels may target only an HTTP loopback origin without credentials or a path.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

export type CloudflareManagedTunnelOptions = {
  accountId: string;
  zoneId: string;
  apiToken: string;
  namingKey: string;
  baseDomain?: string;
  fetchImpl?: typeof fetch;
};

export class CloudflareManagedTunnelProvisioner implements TunnelProvisioner {
  private readonly baseDomain: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CloudflareManagedTunnelOptions) {
    this.baseDomain = options.baseDomain ?? "eventforge.dev";
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!/^[a-z0-9.-]+$/.test(this.baseDomain)) throw new Error("Invalid tunnel base domain.");
  }

  async provision(input: TunnelProvisionInput): Promise<ManagedTunnelLease> {
    const originUrl = validateLocalTunnelOrigin(input.originUrl);
    const slug = threeWordTunnelSlug(input.actorId, input.workspaceId, this.options.namingKey);
    const tunnelName = `eventforge-${slug}`;
    const hostname = `${slug}.${this.baseDomain}`;
    const existing = await this.request<CloudflareTunnel[]>(
      `/accounts/${this.options.accountId}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`,
    );
    let tunnel = existing[0];
    let created = false;
    if (!tunnel) {
      tunnel = await this.request<CloudflareTunnel>(
        `/accounts/${this.options.accountId}/cfd_tunnel`,
        {
          method: "POST",
          body: JSON.stringify({ name: tunnelName, config_src: "cloudflare" }),
        },
      );
      created = true;
    }

    try {
      await this.request(
        `/accounts/${this.options.accountId}/cfd_tunnel/${tunnel.id}/configurations`,
        {
          method: "PUT",
          body: JSON.stringify({
            config: {
              ingress: [
                {
                  hostname,
                  path: "^/webhooks/(github|linear|sentry)$",
                  service: originUrl,
                },
                { hostname, path: "^/health$", service: originUrl },
                { service: "http_status:404" },
              ],
            },
          }),
        },
      );
      await this.upsertDns(hostname, `${tunnel.id}.cfargotunnel.com`);
      const token = await this.request<string>(
        `/accounts/${this.options.accountId}/cfd_tunnel/${tunnel.id}/token`,
      );
      return ManagedTunnelLeaseSchema.parse({
        tunnelId: tunnel.id,
        tunnelName,
        hostname,
        publicUrl: `https://${hostname}`,
        token,
      });
    } catch (error) {
      if (created) {
        await this.request(`/accounts/${this.options.accountId}/cfd_tunnel/${tunnel.id}`, {
          method: "DELETE",
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async upsertDns(hostname: string, content: string): Promise<void> {
    const records = await this.request<CloudflareDnsRecord[]>(
      `/zones/${this.options.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
    );
    const body = JSON.stringify({ type: "CNAME", name: hostname, content, proxied: true, ttl: 1 });
    const existing = records[0];
    if (existing) {
      if (existing.content !== content)
        await this.request(`/zones/${this.options.zoneId}/dns_records/${existing.id}`, {
          method: "PUT",
          body,
        });
      return;
    }
    await this.request(`/zones/${this.options.zoneId}/dns_records`, { method: "POST", body });
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(new URL(path, CLOUDFLARE_API), {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.options.apiToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json()) as CloudflareEnvelope<T>;
    if (!response.ok || !payload.success) {
      const detail = payload.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join("; ");
      throw new Error(`Cloudflare tunnel provisioning failed${detail ? `: ${detail}` : "."}`);
    }
    return payload.result;
  }
}

const TUNNEL_ENV_NAMES = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_API_TOKEN",
  "EVENTFORGE_TUNNEL_NAMING_KEY",
] as const;

/**
 * Variables that only exist to configure EventForge managed tunnels. The
 * CLOUDFLARE_* names are also used by Wrangler and other tools, so on their own
 * they do not mean the operator asked for managed tunnels.
 */
const TUNNEL_INTENT_NAMES = [
  "EVENTFORGE_TUNNEL_NAMING_KEY",
  "EVENTFORGE_TUNNEL_BASE_DOMAIN",
] as const;

/**
 * Build the managed tunnel provisioner from the environment.
 *
 * - Nothing set: provisioning is off.
 * - Every required variable set: provisioning is on.
 * - An EventForge tunnel variable set but a required one missing: the operator
 *   clearly asked for managed tunnels, so this throws with the missing names.
 * - Only generic CLOUDFLARE_* variables set (for example a Wrangler token):
 *   provisioning stays off and `warn` is called once. Startup continues.
 */
export function createTunnelProvisionerFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): TunnelProvisioner | undefined {
  const configured = TUNNEL_ENV_NAMES.filter((name) => environment[name]);
  const intent = TUNNEL_INTENT_NAMES.some((name) => environment[name]);
  if (configured.length === 0 && !intent) return undefined;
  const missing = TUNNEL_ENV_NAMES.filter((name) => !environment[name]);
  if (missing.length) {
    if (intent) throw new Error(`Managed tunnel provisioning requires ${missing.join(", ")}.`);
    warn(
      `EventForge managed tunnel provisioning is disabled: ${configured.join(", ")} ` +
        `${configured.length === 1 ? "is" : "are"} set but ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} not. Set EVENTFORGE_TUNNEL_NAMING_KEY and the ` +
        "other variables to enable it.",
    );
    return undefined;
  }
  return new CloudflareManagedTunnelProvisioner({
    accountId: environment.CLOUDFLARE_ACCOUNT_ID!,
    zoneId: environment.CLOUDFLARE_ZONE_ID!,
    apiToken: environment.CLOUDFLARE_API_TOKEN!,
    namingKey: environment.EVENTFORGE_TUNNEL_NAMING_KEY!,
    baseDomain: environment.EVENTFORGE_TUNNEL_BASE_DOMAIN,
  });
}
