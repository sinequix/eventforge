import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  EventEnvelope,
  Provider,
  ProviderAdapter,
  ProviderDeliveryInput,
  ProviderVerification,
} from "./contracts.js";

const SECRET_FIELD = /(?:api[_-]?key|token|secret|password|authorization|private[_-]?key)/i;

export function verifyHmac(
  payload: string,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!signature || !secret) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

export function verifyBareHmac(
  payload: string,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!signature || !secret || !/^[a-f\d]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(signature, "hex");
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function header(input: ProviderDeliveryInput, name: string): string | undefined {
  const value = input.headers[name.toLowerCase()] ?? input.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value !== "string" || !value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function replayIsValid(occurredAt: number | undefined, now: Date, maxAgeMs: number): boolean {
  return occurredAt !== undefined && Math.abs(now.getTime() - occurredAt) <= maxAgeMs;
}

export function redactPayload(
  value: unknown,
  path = "payload",
): { value: unknown; paths: string[] } {
  if (Array.isArray(value)) {
    const paths: string[] = [];
    return {
      value: value.map((entry, index) => {
        const result = redactPayload(entry, `${path}[${index}]`);
        paths.push(...result.paths);
        return result.value;
      }),
      paths,
    };
  }
  if (value && typeof value === "object") {
    const paths: string[] = [];
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD.test(key)) {
        output[key] = "[REDACTED]";
        paths.push(`${path}.${key}`);
      } else {
        const result = redactPayload(entry, `${path}.${key}`);
        output[key] = result.value;
        paths.push(...result.paths);
      }
    }
    return { value: output, paths };
  }
  return { value, paths: [] };
}

function topicFor(provider: Provider, payload: Record<string, unknown>, hint?: string): string {
  if (hint) return hint;
  if (provider === "github") return String(payload.action ?? "unknown");
  if (provider === "linear") return String(payload.action ?? payload.type ?? "unknown");
  if (provider === "sentry") return String(payload.action ?? payload.event_type ?? "issue");
  return String(payload.type ?? "custom");
}

function dedupeFor(
  provider: Provider,
  payload: Record<string, unknown>,
  deliveryId?: string,
): string {
  if (deliveryId) return `${provider}:${deliveryId}`;
  const nestedId =
    payload.id ?? payload.delivery_id ?? (payload.data as Record<string, unknown> | undefined)?.id;
  return `${provider}:${String(nestedId ?? JSON.stringify(payload))}`;
}

export function normalizeEvent(input: {
  provider: Provider;
  workspaceId: string;
  projectId: string;
  payload: Record<string, unknown>;
  signatureStatus: EventEnvelope["signatureStatus"];
  deliveryId?: string;
  topicHint?: string;
  occurredAt?: string;
  repository?: string;
}): EventEnvelope {
  const redacted = redactPayload(input.payload);
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    provider: input.provider,
    topic: topicFor(input.provider, input.payload, input.topicHint),
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    repository: input.repository,
    occurredAt: input.occurredAt ?? now,
    receivedAt: now,
    signatureStatus: input.signatureStatus,
    dedupeKey: dedupeFor(input.provider, input.payload, input.deliveryId),
    providerDeliveryId: input.deliveryId,
    payloadStorage: "inline",
    payload: redacted.value as Record<string, unknown>,
    redactions: redacted.paths,
  };
}

function normalizedByAdapter(
  provider: Exclude<Provider, "custom">,
  input: Parameters<ProviderAdapter["normalize"]>[0],
): EventEnvelope {
  return normalizeEvent({
    provider,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    repository: input.repository,
    payload: input.payload,
    signatureStatus: input.signatureStatus,
    deliveryId: input.verification.deliveryId,
    topicHint: input.verification.topic,
    occurredAt: input.verification.occurredAt,
  });
}

export const githubProviderAdapter: ProviderAdapter = {
  provider: "github",
  verify(input): ProviderVerification {
    const verified = verifyHmac(input.rawBody, header(input, "x-hub-signature-256"), input.secret);
    const deliveryId = header(input, "x-github-delivery");
    return {
      verified: verified && Boolean(deliveryId),
      reason: !verified
        ? "Invalid GitHub signature."
        : !deliveryId
          ? "Missing GitHub delivery identifier."
          : undefined,
      deliveryId,
      topic: header(input, "x-github-event"),
      installationKey:
        String((input.payload.installation as Record<string, unknown> | undefined)?.id ?? "") ||
        undefined,
    };
  },
  normalize(input) {
    return normalizedByAdapter("github", input);
  },
};

export const linearProviderAdapter: ProviderAdapter = {
  provider: "linear",
  verify(input): ProviderVerification {
    const signatureValid = verifyBareHmac(
      input.rawBody,
      header(input, "linear-signature"),
      input.secret,
    );
    const deliveryId = header(input, "linear-delivery");
    const occurredAtMs = timestamp(input.payload.webhookTimestamp ?? input.payload.createdAt);
    const replayValid = replayIsValid(occurredAtMs, input.now ?? new Date(), 60_000);
    return {
      verified: signatureValid && Boolean(deliveryId) && replayValid,
      reason: !signatureValid
        ? "Invalid Linear signature."
        : !deliveryId
          ? "Missing Linear delivery identifier."
          : !replayValid
            ? "Linear delivery timestamp is outside the replay window."
            : undefined,
      deliveryId,
      topic: String(input.payload.action ?? input.payload.type ?? "unknown"),
      occurredAt: occurredAtMs ? new Date(occurredAtMs).toISOString() : undefined,
      installationKey:
        String(
          (input.payload.organization as Record<string, unknown> | undefined)?.id ??
            input.payload.organizationId ??
            "",
        ) || undefined,
    };
  },
  normalize(input) {
    return normalizedByAdapter("linear", input);
  },
};

export const sentryProviderAdapter: ProviderAdapter = {
  provider: "sentry",
  verify(input): ProviderVerification {
    const signatureValid = verifyBareHmac(
      input.rawBody,
      header(input, "sentry-hook-signature"),
      input.secret,
    );
    const deliveryId = header(input, "request-id");
    const occurredAtMs = timestamp(
      header(input, "sentry-hook-timestamp") ?? input.payload.webhookTimestamp,
    );
    const replayValid = replayIsValid(occurredAtMs, input.now ?? new Date(), 5 * 60_000);
    return {
      verified: signatureValid && Boolean(deliveryId) && replayValid,
      reason: !signatureValid
        ? "Invalid Sentry signature."
        : !deliveryId
          ? "Missing Sentry request identifier."
          : !replayValid
            ? "Sentry delivery timestamp is outside the replay window."
            : undefined,
      deliveryId,
      topic:
        header(input, "sentry-hook-resource") ??
        String(input.payload.event_type ?? input.payload.action ?? "issue"),
      occurredAt: occurredAtMs ? new Date(occurredAtMs).toISOString() : undefined,
      installationKey:
        String((input.payload.installation as Record<string, unknown> | undefined)?.uuid ?? "") ||
        undefined,
    };
  },
  normalize(input) {
    return normalizedByAdapter("sentry", input);
  },
};

export const providerAdapters = {
  github: githubProviderAdapter,
  linear: linearProviderAdapter,
  sentry: sentryProviderAdapter,
} as const;

export function isGitHubCiFailure(event: EventEnvelope): boolean {
  if (event.provider !== "github") return false;
  const payload = event.payload;
  const checkRun = payload.check_run as Record<string, unknown> | undefined;
  if (event.topic === "check_run") return checkRun?.conclusion === "failure";
  const workflowRun = payload.workflow_run as Record<string, unknown> | undefined;
  return (
    event.topic === "workflow_run" &&
    payload.action === "completed" &&
    workflowRun?.conclusion === "failure"
  );
}

export function isGitHubIssueOpened(event: EventEnvelope): boolean {
  return (
    event.provider === "github" &&
    event.topic === "issues" &&
    event.payload.action === "opened" &&
    typeof event.payload.issue === "object"
  );
}

export function isGitHubIssueEvent(event: EventEnvelope): boolean {
  return (
    event.provider === "github" &&
    ["issues", "issue_comment"].includes(event.topic) &&
    typeof event.payload.issue === "object"
  );
}

const GITHUB_PULL_REQUEST_REVIEW_ACTIONS = new Set(["opened", "reopened", "synchronize"]);

export function isGitHubPullRequestReviewEvent(event: EventEnvelope): boolean {
  return (
    event.provider === "github" &&
    event.topic === "pull_request" &&
    GITHUB_PULL_REQUEST_REVIEW_ACTIONS.has(String(event.payload.action ?? "")) &&
    typeof event.payload.pull_request === "object"
  );
}

export function githubPullRequestNumber(event: EventEnvelope): number | undefined {
  if (event.provider !== "github" || event.topic !== "pull_request") return undefined;
  const pullRequest = event.payload.pull_request as Record<string, unknown> | undefined;
  const number = pullRequest?.number ?? event.payload.number;
  return typeof number === "number" && Number.isInteger(number) ? number : undefined;
}

export const demoEvents = {
  githubCiFailure: {
    action: "check_run",
    repository: { full_name: "eventforge/demo-service", default_branch: "main" },
    check_run: {
      id: 821,
      name: "test",
      status: "completed",
      conclusion: "failure",
      details_url: "https://github.com/eventforge/demo-service/actions/runs/821",
    },
    installation: { id: 10 },
    authorization: "intentionally-redacted-by-normalizer",
  },
  linearIssue: {
    action: "create",
    type: "Issue",
    data: { id: "LIN-42", title: "CI is flaky on the release branch", team: { key: "ENG" } },
  },
  sentryIssue: {
    action: "created",
    event_type: "issue",
    data: { issue: { id: "SENTRY-92", title: "TypeError in checkout", level: "error" } },
  },
} as const;
