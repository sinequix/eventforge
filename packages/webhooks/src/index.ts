import { standardWebhooks } from "@eventforge/core";

export const verify = standardWebhooks.verifyStandardWebhook;
export const sign = standardWebhooks.signStandardWebhook;
export const generateSigningSecret = standardWebhooks.generateSigningSecret;
export const WebhookVerificationError = standardWebhooks.WebhookVerificationError;

export type PublishEvent = {
  installationId: string;
  eventType: string;
  channel?: string;
  payload: Record<string, unknown>;
};

export type PublishResult = {
  accepted: true;
  duplicate: boolean;
  eventId: string;
  deliveryIds: string[];
  matchedDestinationCount: number;
};

export type ReplayResult = {
  accepted: true;
  replayed: true;
  deliveryId: string;
  eventId: string | null;
};

export type EventForgeWebhooksOptions = {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
};

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export class EventForgeWebhooks {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: EventForgeWebhooksOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async publish(
    workspaceId: string,
    event: PublishEvent,
    options: { idempotencyKey: string } | string,
  ): Promise<PublishResult> {
    const idempotencyKey = typeof options === "string" ? options : options.idempotencyKey;
    return this.request<PublishResult>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/events`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(event),
    });
  }

  async replay(
    workspaceId: string,
    deliveryId: string,
    options: { reason: string; idempotencyKey?: string },
  ): Promise<ReplayResult> {
    const headers: Record<string, string> = {};
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    return this.request<ReplayResult>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
      { method: "POST", headers, body: JSON.stringify({ reason: options.reason }) },
    );
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.options.apiKey}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await this.fetchImpl(joinUrl(this.options.baseUrl, path), {
      ...init,
      headers,
    });
    const body = (await response.json()) as T & { detail?: string; code?: string };
    if (!response.ok) {
      throw new Error(body.detail ?? body.code ?? `EventForge request failed (${response.status})`);
    }
    return body;
  }
}
