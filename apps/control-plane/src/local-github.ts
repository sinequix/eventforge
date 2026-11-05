import { randomBytes } from "node:crypto";
import { ManagedTunnelLeaseSchema, type ManagedTunnelLease } from "@eventforge/core";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DEFAULT_ORIGIN = "http://127.0.0.1:4310";
const DEFAULT_WEBHOOK_PATH = "/webhooks/github";
const QUICK_TUNNEL_TIMEOUT_MS = 30_000;
const QUICK_TUNNEL_ATTEMPTS = 3;
const QUICK_TUNNEL_RETRY_DELAY_MS = 1_000;
const TUNNEL_READY_TIMEOUT_MS = 30_000;
const GITHUB_WEBHOOK_EVENTS = [
  "check_run",
  "workflow_run",
  "push",
  "issues",
  "pull_request",
  "pull_request_review",
  "issue_comment",
] as const;

type StoredWebhook = {
  repository: string;
  hookId: number;
  publicUrl?: string;
  tunnel?: "cloudflare_quick" | "cloudflare_named" | "eventforge_managed";
};
type GitHubHook = { id: number; config?: { url?: string } };

export type LocalGitHubWebhook = {
  repository: string;
  publicUrl: string;
  publicBaseUrl: string;
  tunnelName?: string;
  hookId: number;
  close: () => Promise<void>;
};

export function envValue(contents: string, key: string): string | undefined {
  const match = contents.match(new RegExp(`^${key}=([^\\r\\n]*)$`, "m"));
  return match?.[1] || undefined;
}

export function webhookFormArgs(relayUrl: string, secret: string): string[] {
  return [
    "-f",
    "name=web",
    "-F",
    "active=true",
    ...GITHUB_WEBHOOK_EVENTS.flatMap((event) => ["-f", `events[]=${event}`]),
    "-f",
    `config[url]=${relayUrl}`,
    "-f",
    "config[content_type]=json",
    "-f",
    `config[secret]=${secret}`,
    "-f",
    "config[insecure_ssl]=0",
  ];
}

export function quickTunnelUrl(output: string): string | undefined {
  return output.match(
    /https:\/\/(?!api\.trycloudflare\.com\b)[-a-z0-9]+\.trycloudflare\.com\b/i,
  )?.[0];
}

export function publicWebhookUrl(tunnelUrl: string, webhookPath = DEFAULT_WEBHOOK_PATH): string {
  return new URL(webhookPath, `${tunnelUrl}/`).toString();
}

export function quickTunnelArgs(originUrl: string, configPath = devNull): string[] {
  return ["--config", configPath, "tunnel", "--url", originUrl];
}

export function namedTunnelArgs(
  originUrl: string,
  tunnelName: string,
  configPath = devNull,
): string[] {
  return ["--config", configPath, "tunnel", "--url", originUrl, "run", tunnelName];
}

export function tokenTunnelArgs(tokenPath: string): string[] {
  return ["tunnel", "--no-autoupdate", "run", "--token-file", tokenPath];
}

async function requestManagedTunnelLease(
  provisioningUrl: string,
  bearerToken: string,
  originUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManagedTunnelLease> {
  const response = await fetchImpl(new URL("/tunnels/provision", `${provisioningUrl}/`), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${bearerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ originUrl }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300).trim();
    throw new Error(
      `EventForge tunnel provisioning returned ${response.status}${detail ? `: ${detail}` : "."}`,
    );
  }
  return ManagedTunnelLeaseSchema.parse(await response.json());
}

async function command(args: string[]): Promise<string> {
  const result = await execFile("gh", args, { maxBuffer: 1_000_000 });
  return result.stdout.trim();
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function ensureSecret(envPath: string): Promise<string> {
  const current = await readOptional(envPath);
  const existing = envValue(current, "GITHUB_WEBHOOK_SECRET");
  if (existing) return existing;

  const secret = randomBytes(32).toString("base64url");
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, `${current}${prefix}GITHUB_WEBHOOK_SECRET=${secret}\n`, { mode: 0o600 });
  await chmod(envPath, 0o600);
  return secret;
}

async function loadStoredWebhook(statePath: string): Promise<StoredWebhook | undefined> {
  const contents = await readOptional(statePath);
  if (!contents) return undefined;
  try {
    const parsed = JSON.parse(contents) as StoredWebhook;
    return typeof parsed.repository === "string" && Number.isInteger(parsed.hookId)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

async function hookExists(repository: string, hookId: number): Promise<boolean> {
  try {
    const response = await command(["api", `repos/${repository}/hooks/${hookId}`]);
    const hook = JSON.parse(response) as GitHubHook;
    return hook.id === hookId;
  } catch {
    return false;
  }
}

async function createHook(repository: string, relayUrl: string, secret: string): Promise<number> {
  try {
    const response = await command([
      "api",
      "--method",
      "POST",
      `repos/${repository}/hooks`,
      ...webhookFormArgs(relayUrl, secret),
    ]);
    const hook = JSON.parse(response) as GitHubHook;
    if (!Number.isInteger(hook.id)) throw new Error("GitHub created a webhook without an id.");
    return hook.id;
  } catch (error: unknown) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(
      stderr
        ? `Could not register the GitHub webhook: ${stderr}`
        : "Could not register the GitHub webhook.",
    );
  }
}

async function patchHook(
  repository: string,
  hookId: number,
  publicUrl: string,
  secret: string,
): Promise<void> {
  try {
    await command([
      "api",
      "--method",
      "PATCH",
      `repos/${repository}/hooks/${hookId}`,
      ...webhookFormArgs(publicUrl, secret),
    ]);
  } catch (error: unknown) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(
      stderr
        ? `Could not update the GitHub webhook: ${stderr}`
        : "Could not update the GitHub webhook.",
    );
  }
}

async function startTunnelAttempt(
  cloudflaredBin: string,
  args: string[],
  publishedUrl?: string,
): Promise<{ tunnelUrl: string; close: () => Promise<void> }> {
  const tunnel = spawn(cloudflaredBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  let tunnelUrl = publishedUrl;
  let settle: ((value: { tunnelUrl: string; close: () => Promise<void> }) => void) | undefined;
  let fail: ((reason: Error) => void) | undefined;
  const ready = new Promise<{ tunnelUrl: string; close: () => Promise<void> }>(
    (resolve, reject) => {
      settle = resolve;
      fail = reject;
    },
  );
  const stop = async () => {
    if (tunnel.exitCode !== null) return;
    if (!tunnel.killed) tunnel.kill("SIGTERM");
    await Promise.race([
      once(tunnel, "exit"),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]).catch(() => undefined);
    if (tunnel.exitCode === null) tunnel.kill("SIGKILL");
  };
  const finish = () =>
    settle?.({
      tunnelUrl: tunnelUrl!,
      close: stop,
    });
  const inspect = (chunk: Buffer) => {
    const text = chunk.toString();
    output.push(text);
    tunnelUrl ??= quickTunnelUrl(text);
    if (tunnelUrl) finish();
  };
  tunnel.stdout.on("data", inspect);
  tunnel.stderr.on("data", inspect);
  tunnel.once("error", (error) =>
    fail?.(
      new Error(
        `Could not start ${cloudflaredBin}: ${error.message}. Install cloudflared and retry.`,
      ),
    ),
  );
  tunnel.once("exit", (code, signal) => {
    if (!tunnelUrl)
      fail?.(
        new Error(
          `Cloudflare Quick Tunnel exited before publishing a URL (code ${code ?? "unknown"}, signal ${signal ?? "none"}): ${output.join("").trim()}`,
        ),
      );
  });
  if (tunnelUrl) queueMicrotask(finish);
  const timeout = setTimeout(() => {
    if (!tunnelUrl) {
      void stop().finally(() =>
        fail?.(
          new Error(
            `Cloudflare Tunnel did not publish a URL within ${QUICK_TUNNEL_TIMEOUT_MS / 1000} seconds.`,
          ),
        ),
      );
    }
  }, QUICK_TUNNEL_TIMEOUT_MS);
  try {
    return await ready;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForQuickTunnel(
  originUrl: string,
  cloudflaredBin: string,
  configPath?: string,
): Promise<{ tunnelUrl: string; close: () => Promise<void> }> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= QUICK_TUNNEL_ATTEMPTS; attempt += 1) {
    try {
      return await startTunnelAttempt(cloudflaredBin, quickTunnelArgs(originUrl, configPath));
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error("Cloudflare Quick Tunnel failed to start.");
      if (attempt < QUICK_TUNNEL_ATTEMPTS)
        await new Promise((resolve) => setTimeout(resolve, QUICK_TUNNEL_RETRY_DELAY_MS));
    }
  }
  throw new Error(
    `Cloudflare Quick Tunnel failed after ${QUICK_TUNNEL_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`,
  );
}

async function waitForTunnelHealth(
  tunnelUrl: string,
  timeoutMs = TUNNEL_READY_TIMEOUT_MS,
): Promise<void> {
  const healthUrl = new URL("/health", `${tunnelUrl}/`);
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
      lastStatus = `HTTP ${response.status}`;
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : "connection failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Cloudflare Quick Tunnel did not reach ${healthUrl} within ${timeoutMs / 1000} seconds (${lastStatus}).`,
  );
}

async function waitForHealthyTunnel(
  startTunnel: () => Promise<{ tunnelUrl: string; close: () => Promise<void> }>,
  readyTimeoutMs?: number,
): Promise<{ tunnelUrl: string; close: () => Promise<void> }> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= QUICK_TUNNEL_ATTEMPTS; attempt += 1) {
    const tunnel = await startTunnel();
    try {
      await waitForTunnelHealth(tunnel.tunnelUrl, readyTimeoutMs);
      return tunnel;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Quick Tunnel health check failed.");
      await tunnel.close();
      if (attempt < QUICK_TUNNEL_ATTEMPTS)
        await new Promise((resolve) => setTimeout(resolve, QUICK_TUNNEL_RETRY_DELAY_MS));
    }
  }
  throw new Error(
    `Cloudflare Tunnel remained unhealthy after ${QUICK_TUNNEL_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`,
  );
}

/**
 * Starts a Cloudflare Quick Tunnel for the local control plane and patches the
 * saved GitHub engineering-event webhook on every launch. Quick Tunnel hostnames are
 * intentionally short-lived, while the GitHub webhook and signing secret persist.
 */
export async function startLocalGitHubWebhook(
  options: {
    rootDir?: string;
    legacyRootDirs?: string[];
    repository?: string;
    originUrl?: string;
    webhookPath?: string;
    cloudflaredBin?: string;
    cloudflaredConfig?: string;
    namedTunnel?: string;
    namedTunnelPublicUrl?: string;
    provisioningUrl?: string;
    provisioningToken?: string;
    provisioningFetch?: typeof fetch;
    tunnelReadyTimeoutMs?: number;
    log?: (message: string) => void;
  } = {},
): Promise<LocalGitHubWebhook> {
  const rootDir = options.rootDir ?? process.cwd();
  const envPath = join(rootDir, ".env");
  const statePath = join(rootDir, ".eventforge", "github-local-webhook.json");
  const stored =
    (await loadStoredWebhook(statePath)) ??
    (
      await Promise.all(
        (options.legacyRootDirs ?? []).map((legacyRootDir) =>
          loadStoredWebhook(join(legacyRootDir, ".eventforge", "github-local-webhook.json")),
        ),
      )
    ).find(Boolean);
  const repository =
    options.repository ??
    process.env.EVENTFORGE_GITHUB_REPOSITORY ??
    (await command(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]));
  if (!repository.includes("/"))
    throw new Error(
      "Could not determine the GitHub repository. Set EVENTFORGE_GITHUB_REPOSITORY=owner/repository.",
    );
  process.env.EVENTFORGE_GITHUB_REPOSITORY = repository;

  const originUrl =
    options.originUrl ?? process.env.EVENTFORGE_LOCAL_TUNNEL_ORIGIN ?? DEFAULT_ORIGIN;
  const cloudflaredBin =
    options.cloudflaredBin ?? process.env.EVENTFORGE_CLOUDFLARED_BIN ?? "cloudflared";
  const cloudflaredConfig = options.cloudflaredConfig ?? process.env.EVENTFORGE_CLOUDFLARED_CONFIG;
  const namedTunnel = options.namedTunnel ?? process.env.EVENTFORGE_CLOUDFLARED_TUNNEL;
  const namedTunnelPublicUrl =
    options.namedTunnelPublicUrl ?? process.env.EVENTFORGE_CLOUDFLARED_PUBLIC_URL;
  const provisioningUrl = options.provisioningUrl ?? process.env.EVENTFORGE_TUNNEL_PROVISIONING_URL;
  const provisioningToken =
    options.provisioningToken ??
    process.env.EVENTFORGE_TUNNEL_PROVISIONING_TOKEN ??
    process.env.EVENTFORGE_API_TOKEN;
  if (provisioningUrl && !provisioningToken)
    throw new Error(
      "Set both EVENTFORGE_TUNNEL_PROVISIONING_URL and a provisioning/API token for an EventForge-managed tunnel.",
    );
  if ((namedTunnel && !namedTunnelPublicUrl) || (!namedTunnel && namedTunnelPublicUrl))
    throw new Error(
      "Set both EVENTFORGE_CLOUDFLARED_TUNNEL and EVENTFORGE_CLOUDFLARED_PUBLIC_URL for a named tunnel.",
    );
  const managedLease =
    provisioningUrl && provisioningToken
      ? await requestManagedTunnelLease(
          provisioningUrl,
          provisioningToken,
          originUrl,
          options.provisioningFetch,
        )
      : undefined;
  const tokenPath = managedLease
    ? join(rootDir, ".eventforge", `${managedLease.tunnelId}.token`)
    : undefined;
  if (managedLease && tokenPath) {
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, `${managedLease.token}\n`, { mode: 0o600 });
    await chmod(tokenPath, 0o600);
  }
  let tunnel: { tunnelUrl: string; close: () => Promise<void> } | undefined;
  try {
    tunnel = await waitForHealthyTunnel(
      () =>
        managedLease && tokenPath
          ? startTunnelAttempt(cloudflaredBin, tokenTunnelArgs(tokenPath), managedLease.publicUrl)
          : namedTunnel && namedTunnelPublicUrl
            ? startTunnelAttempt(
                cloudflaredBin,
                namedTunnelArgs(originUrl, namedTunnel, cloudflaredConfig),
                namedTunnelPublicUrl,
              )
            : waitForQuickTunnel(originUrl, cloudflaredBin, cloudflaredConfig),
      options.tunnelReadyTimeoutMs,
    );
    const activeTunnel = tunnel;
    const webhookUrl = publicWebhookUrl(activeTunnel.tunnelUrl, options.webhookPath);
    const secret = await ensureSecret(envPath);
    process.env.GITHUB_WEBHOOK_SECRET = secret;

    const isReusable =
      stored?.repository === repository && (await hookExists(repository, stored.hookId));
    const hookId = isReusable ? stored.hookId : await createHook(repository, webhookUrl, secret);
    if (isReusable) await patchHook(repository, hookId, webhookUrl, secret);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      `${JSON.stringify({ repository, hookId, publicUrl: webhookUrl, tunnelUrl: activeTunnel.tunnelUrl, tunnelName: managedLease?.tunnelName ?? namedTunnel, tunnel: managedLease ? "eventforge_managed" : namedTunnel ? "cloudflare_named" : "cloudflare_quick" }, null, 2)}\n`,
      { mode: 0o600 },
    );

    options.log?.(
      `GitHub webhook #${hookId} now targets ${webhookUrl} through Cloudflare ${managedLease ? `EventForge-managed tunnel ${managedLease.tunnelName}` : namedTunnel ? `named tunnel ${namedTunnel}` : "Quick Tunnel"} at ${activeTunnel.tunnelUrl}, forwarding to ${originUrl}.`,
    );

    return {
      repository,
      publicUrl: webhookUrl,
      publicBaseUrl: activeTunnel.tunnelUrl,
      tunnelName: managedLease?.tunnelName ?? namedTunnel,
      hookId,
      close: async () => {
        await activeTunnel.close();
        if (tokenPath) await unlink(tokenPath).catch(() => undefined);
      },
    };
  } catch (error) {
    await tunnel?.close();
    if (tokenPath) await unlink(tokenPath).catch(() => undefined);
    throw error;
  }
}

export const localWebhookStatePath = (rootDir = process.cwd()) =>
  resolve(rootDir, ".eventforge", "github-local-webhook.json");
