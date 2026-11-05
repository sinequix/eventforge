import { createHmac, randomUUID } from "node:crypto";

export type NotificationStatus =
  "completed" | "waiting_for_approval" | "approved" | "rejected" | "failed";

export type RunNotification = {
  event: {
    id: string;
    provider: string;
    topic: string;
    deliveryId?: string;
    signatureStatus: string;
  };
  run: { id: string; workflowId: string; status: string; summary?: string };
  proposal: { id: string; title: string; status: string; type: string } | null;
  repo: string | null;
  status: NotificationStatus;
  link: string | null;
};

type Logger = {
  info: (object: Record<string, unknown>, message: string) => void;
  warn: (object: Record<string, unknown>, message: string) => void;
};

export type NotifierOptions = {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  maxAttempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Signs `${timestamp}.${body}` so a receiver can reject replayed or reordered deliveries. */
export function signNotification(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function validateNotifyUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password)
    throw new Error("EVENTFORGE_NOTIFY_URL must not embed credentials.");
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new Error(
    "EVENTFORGE_NOTIFY_URL must use https (plain http is allowed only for loopback).",
  );
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Delivers signed run notifications in the background. `notify` never throws and never
 * awaits the network, so webhook ingestion and approval decisions are never blocked.
 * Logs carry the delivery id, attempt, and HTTP status only: never the secret, the
 * signature, the body, or the destination path/query.
 */
export class WebhookNotifier {
  readonly #url: URL;
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log?: Logger;
  readonly #pending = new Set<Promise<void>>();

  constructor(options: NotifierOptions) {
    if (!options.secret) throw new Error("EVENTFORGE_NOTIFY_SECRET is required.");
    this.#url = validateNotifyUrl(options.url);
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? fetch;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    this.#baseDelayMs = Math.max(0, options.baseDelayMs ?? 1_000);
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#log = options.log;
  }

  notify(notification: RunNotification): string {
    const deliveryId = randomUUID();
    const task = this.#deliver(deliveryId, notification)
      .catch(() => undefined)
      .finally(() => this.#pending.delete(task));
    this.#pending.add(task);
    return deliveryId;
  }

  /** Waits for in-flight deliveries; used by tests and graceful shutdown. */
  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.all([...this.#pending]);
  }

  async #deliver(deliveryId: string, notification: RunNotification): Promise<void> {
    const body = JSON.stringify(notification);
    const destination = this.#url.host;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const timestamp = String(Math.floor(this.#now() / 1000));
      let status: number | undefined;
      try {
        const response = await this.#fetch(this.#url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "EventForge-Notifier/1",
            "x-eventforge-delivery": deliveryId,
            "x-eventforge-timestamp": timestamp,
            "x-eventforge-event": notification.status,
            "x-eventforge-signature": signNotification(this.#secret, timestamp, body),
          },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
          redirect: "error",
        });
        status = response.status;
        await response.body?.cancel().catch(() => undefined);
        if (response.ok) {
          this.#log?.info(
            { deliveryId, attempt, status, destination },
            "run notification delivered",
          );
          return;
        }
        if (!retryable(status)) {
          this.#log?.warn(
            { deliveryId, attempt, status, destination },
            "run notification rejected; not retrying",
          );
          return;
        }
      } catch (error) {
        this.#log?.warn(
          {
            deliveryId,
            attempt,
            destination,
            reason: error instanceof Error ? error.name : "unknown",
          },
          "run notification attempt failed",
        );
      }
      if (attempt < this.#maxAttempts) await this.#sleep(this.#baseDelayMs * 2 ** (attempt - 1));
    }
    this.#log?.warn(
      { deliveryId, attempts: this.#maxAttempts, destination },
      "run notification abandoned after retries",
    );
  }
}

export function createNotifierFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
  log?: Logger,
): WebhookNotifier | undefined {
  const url = environment.EVENTFORGE_NOTIFY_URL;
  const secret = environment.EVENTFORGE_NOTIFY_SECRET;
  if (!url && !secret) return undefined;
  if (!url || !secret)
    throw new Error("EVENTFORGE_NOTIFY_URL and EVENTFORGE_NOTIFY_SECRET must be set together.");
  return new WebhookNotifier({ url, secret, log });
}
