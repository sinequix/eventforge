import { getRequestToken } from "./SignInPage";

const REQUEST_TOKEN_HEADER = "x-eventforge-request-token";
const configuredBaseUrl = import.meta.env.VITE_EVENTFORGE_API_URL;

declare global {
  interface Window {
    eventforgeDesktop?: {
      localDaemonUrl: string;
      controlPlaneUrl: string;
      platform: string;
      request: (
        path: string,
        init: { method?: string; body?: string; headers?: Record<string, string> },
      ) => Promise<{ ok: boolean; status: number; body: string }>;
    };
  }
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type JsonRecord = Record<string, unknown>;
type Parser<T> = (value: unknown) => T;

function record(value: unknown, context: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError(`Invalid ${context} response.`);
  return value as JsonRecord;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ApiError(`Invalid response field: ${field}.`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  // D1 JSON columns serialize SQL NULL as JSON null. Treat that as absent so a
  // delivery without a safeReason (or similar optional field) still renders.
  if (value === undefined || value === null) return undefined;
  return string(value, field);
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new ApiError(`Invalid response field: ${field}.`);
  return value;
}

function array<T>(parser: Parser<T>, context: string): Parser<T[]> {
  return (value) => {
    if (!Array.isArray(value)) throw new ApiError(`Invalid ${context} response.`);
    return value.map(parser);
  };
}

function baseUrl(): string {
  return configuredBaseUrl ?? window.eventforgeDesktop?.controlPlaneUrl ?? "http://127.0.0.1:4310";
}

async function request<T>(
  path: string,
  parser: Parser<T>,
  init: RequestInit = {},
  origin: "control-plane" | "hosted" = "control-plane",
): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    const requestToken = getRequestToken();
    if (requestToken && !headers.has(REQUEST_TOKEN_HEADER))
      headers.set(REQUEST_TOKEN_HEADER, requestToken);
    const desktop = window.eventforgeDesktop;
    if (desktop) {
      const result = await desktop.request(path, {
        method: init.method,
        body: typeof init.body === "string" ? init.body : undefined,
        headers: Object.fromEntries(headers.entries()),
      });
      response = new Response([204, 205, 304].includes(result.status) ? null : result.body, {
        status: result.status,
      });
    } else {
      // Hosted /v1 stays on the console origin so the SameSite=Strict session
      // cookie is sent. The console Worker proxies that path to the API.
      const url = origin === "hosted" ? path : new URL(path, baseUrl());
      response = await fetch(url, {
        ...init,
        credentials: "include",
        headers,
      });
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("Unable to reach the EventForge control plane.");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    try {
      const problem = JSON.parse(detail) as { detail?: unknown };
      if (typeof problem.detail === "string" && problem.detail)
        throw new ApiError(problem.detail, response.status);
    } catch (error) {
      if (error instanceof ApiError) throw error;
    }
    throw new ApiError(detail || `Request failed with status ${response.status}.`, response.status);
  }

  const body = await response.json().catch(() => {
    throw new ApiError("The control plane returned invalid JSON.", response.status);
  });
  return parser(body);
}

const parseEvent: Parser<EventItem> = (value) => {
  const item = record(value, "event");
  return {
    id: string(item.id, "event.id"),
    provider: string(item.provider, "event.provider"),
    topic: string(item.topic, "event.topic"),
    signatureStatus: string(item.signatureStatus, "event.signatureStatus"),
    receivedAt: string(item.receivedAt, "event.receivedAt"),
    payload: record(item.payload, "event.payload"),
  };
};
const parseAction: Parser<ActionItem> = (value) => {
  const item = record(value, "action");
  return {
    id: string(item.id, "action.id"),
    title: string(item.title, "action.title"),
    type: string(item.type, "action.type"),
    risk: string(item.risk, "action.risk"),
    status: string(item.status, "action.status"),
    diff: optionalString(item.diff, "action.diff"),
    requiredCapabilities: strings(item.requiredCapabilities, "action.requiredCapabilities"),
  };
};
const parseRun: Parser<RunItem> = (value) => {
  const item = record(value, "run");
  return {
    id: string(item.id, "run.id"),
    status: string(item.status, "run.status"),
    summary: optionalString(item.summary, "run.summary"),
    startedAt: string(item.startedAt, "run.startedAt"),
    threadId: optionalString(item.threadId, "run.threadId"),
  };
};
const parseAudit: Parser<AuditItem> = (value) => {
  const item = record(value, "audit entry");
  return {
    id: string(item.id, "audit.id"),
    kind: string(item.kind, "audit.kind"),
    message: string(item.message, "audit.message"),
    createdAt: string(item.createdAt, "audit.createdAt"),
  };
};
const parseMemory: Parser<MemoryItem> = (value) => {
  const item = record(value, "memory");
  return {
    id: string(item.id, "memory.id"),
    text: string(item.text, "memory.text"),
    tags: strings(item.tags, "memory.tags"),
    createdAt: string(item.createdAt, "memory.createdAt"),
  };
};
const parseConnector: Parser<ConnectorItem> = (value) => {
  const item = record(value, "connector");
  return {
    provider: string(item.provider, "connector.provider"),
    status: string(item.status, "connector.status"),
    capabilities: strings(item.capabilities, "connector.capabilities"),
  };
};
const parseForge: Parser<ForgeItem> = (value) => {
  const item = record(value, "forge job");
  const validation = record(item.validation, "forge.validation");
  if (typeof validation.passed !== "boolean")
    throw new ApiError("Invalid response field: forge.validation.passed.");
  if (!Array.isArray(item.generatedFiles))
    throw new ApiError("Invalid response field: forge.generatedFiles.");
  return {
    id: string(item.id, "forge.id"),
    prompt: string(item.prompt, "forge.prompt"),
    status: string(item.status, "forge.status"),
    requestedScopes: strings(item.requestedScopes, "forge.requestedScopes"),
    validation: {
      passed: validation.passed,
      findings: strings(validation.findings, "forge.validation.findings"),
    },
    generatedFiles: item.generatedFiles.map((value) => {
      const file = record(value, "forge file");
      return {
        path: string(file.path, "forge.file.path"),
        content: string(file.content, "forge.file.content"),
      };
    }),
  };
};

function idempotencyKey(operation: string, id: string): string {
  return `${operation}:${id}:${crypto.randomUUID()}`;
}

const passThrough = <T>(value: unknown) => value as T;

export const api = {
  events: (signal?: AbortSignal) => request("/events", array(parseEvent, "events"), { signal }),
  actions: (signal?: AbortSignal) => request("/actions", array(parseAction, "actions"), { signal }),
  runs: (signal?: AbortSignal) => request("/runs", array(parseRun, "runs"), { signal }),
  audit: (signal?: AbortSignal) => request("/audit", array(parseAudit, "audit"), { signal }),
  memory: (signal?: AbortSignal) =>
    request("/memory?q=CI", array(parseMemory, "memory"), { signal }),
  connectors: (signal?: AbortSignal) =>
    request("/connectors", array(parseConnector, "connectors"), { signal }),
  forges: (signal?: AbortSignal) => request("/forge", array(parseForge, "forge jobs"), { signal }),
  demo: (provider: "github" | "linear" | "sentry", signal?: AbortSignal) =>
    request("/events/demo", passThrough, {
      method: "POST",
      body: JSON.stringify({ provider }),
      signal,
      headers: { "Idempotency-Key": idempotencyKey("demo", provider) },
    }),
  decideAction: (id: string, approved: boolean, signal?: AbortSignal) =>
    request(`/actions/${encodeURIComponent(id)}/decision`, passThrough, {
      method: "POST",
      body: JSON.stringify({ approved }),
      signal,
      headers: { "Idempotency-Key": idempotencyKey("action", id) },
    }),
  forge: (prompt: string, signal?: AbortSignal) =>
    request("/forge", parseForge, {
      method: "POST",
      body: JSON.stringify({ prompt }),
      signal,
      headers: { "Idempotency-Key": idempotencyKey("forge", prompt) },
    }),
  decideForge: (id: string, approved: boolean, signal?: AbortSignal) =>
    request(`/forge/${encodeURIComponent(id)}/decision`, passThrough, {
      method: "POST",
      body: JSON.stringify({ approved }),
      signal,
      headers: { "Idempotency-Key": idempotencyKey("forge-decision", id) },
    }),
};

function itemsParser<T>(parser: Parser<T>, context: string): Parser<T[]> {
  return (value) => array(parser, context)(record(value, context).items);
}

const parseInstallation: Parser<InstallationItem> = (value) => {
  const item = record(value, "installation");
  return {
    id: string(item.id, "installation.id"),
    workspaceId: string(item.workspaceId, "installation.workspaceId"),
    provider: string(item.provider, "installation.provider"),
    installationKey: string(item.installationKey, "installation.installationKey"),
    status: string(item.status, "installation.status"),
  };
};

const parseDestination: Parser<DestinationItem> = (value) => {
  const item = record(value, "destination");
  return {
    id: string(item.id, "destination.id"),
    workspaceId: string(item.workspaceId, "destination.workspaceId"),
    installationId: string(item.installationId, "destination.installationId"),
    url: string(item.url, "destination.url"),
    description: optionalString(item.description, "destination.description") ?? "",
    eventTypes: strings(item.eventTypes, "destination.eventTypes"),
    channels: strings(item.channels, "destination.channels"),
    maxRatePerSecond: typeof item.maxRatePerSecond === "number" ? item.maxRatePerSecond : 10,
    mode: string(item.mode, "destination.mode"),
    status: string(item.status, "destination.status"),
    secretHint: optionalString(item.secretHint, "destination.secretHint") ?? "",
    secret: optionalString(item.secret, "destination.secret"),
  };
};

const parseMember: Parser<MemberItem> = (value) => {
  const item = record(value, "member");
  return {
    identityId: string(item.identityId, "member.identityId"),
    email: string(item.email, "member.email"),
    role: string(item.role, "member.role"),
    createdAt: string(item.createdAt, "member.createdAt"),
  };
};

const parseInvitation: Parser<InvitationItem> = (value) => {
  const item = record(value, "invitation");
  return {
    id: string(item.id, "invitation.id"),
    workspaceId: string(item.workspaceId, "invitation.workspaceId"),
    email: string(item.email, "invitation.email"),
    role: string(item.role, "invitation.role"),
    identityId: optionalString(item.identityId, "invitation.identityId"),
    acceptedAt: optionalString(item.acceptedAt, "invitation.acceptedAt"),
  };
};

const parsePublish: Parser<PublishResult> = (value) => {
  const item = record(value, "publish");
  return {
    accepted: item.accepted === true,
    duplicate: item.duplicate === true,
    eventId: string(item.eventId, "publish.eventId"),
    deliveryIds: strings(item.deliveryIds ?? [], "publish.deliveryIds"),
    matchedDestinationCount:
      typeof item.matchedDestinationCount === "number" ? item.matchedDestinationCount : 0,
  };
};

const parseDelivery: Parser<DeliveryLogItem> = (value) => {
  const item = record(value, "delivery");
  return {
    id: string(item.id, "delivery.id"),
    status: string(item.status, "delivery.status"),
    eventId: optionalString(item.eventId, "delivery.eventId"),
    destinationId: optionalString(item.destinationId, "delivery.destinationId"),
    attemptsCount:
      typeof item.attemptsCount === "number" ? item.attemptsCount : Number(item.attemptsCount ?? 0),
    safeReason: optionalString(item.safeReason, "delivery.safeReason"),
    createdAt: string(item.createdAt, "delivery.createdAt"),
  };
};

function parsePermission(value: unknown, field: string): ApiKeyPermission {
  if (value === "none" || value === "read" || value === "write") return value;
  throw new ApiError(`Invalid response field: ${field}.`);
}

const parseApiKey: Parser<ApiKeyItem> = (value) => {
  const item = record(value, "apiKey");
  const permissions = record(item.permissions, "apiKey.permissions");
  return {
    id: string(item.id, "apiKey.id"),
    workspaceId: string(item.workspaceId, "apiKey.workspaceId"),
    name: string(item.name, "apiKey.name"),
    prefix: string(item.prefix, "apiKey.prefix"),
    permissions: {
      events: parsePermission(permissions.events, "apiKey.permissions.events"),
      destinations: parsePermission(permissions.destinations, "apiKey.permissions.destinations"),
      deliveries: parsePermission(permissions.deliveries, "apiKey.permissions.deliveries"),
      replay: parsePermission(permissions.replay, "apiKey.permissions.replay"),
    },
    lastUsedAt: optionalString(item.lastUsedAt, "apiKey.lastUsedAt"),
    createdAt: string(item.createdAt, "apiKey.createdAt"),
    token: optionalString(item.token, "apiKey.token"),
  };
};

function hostedRequest<T>(path: string, parser: Parser<T>, init: RequestInit = {}): Promise<T> {
  return request(path, parser, init, "hosted");
}

export const webhookApi = {
  installations: (workspaceId: string, signal?: AbortSignal) =>
    hostedRequest(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/installations`,
      itemsParser(parseInstallation, "installations"),
      { signal },
    ),
  createInstallation: (workspaceId: string, signal?: AbortSignal) =>
    hostedRequest(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/installations`,
      parseInstallation,
      { method: "POST", body: JSON.stringify({ provider: "custom" }), signal },
    ),
  destinations: (workspaceId: string, installationId: string, signal?: AbortSignal) =>
    hostedRequest(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/installations/${encodeURIComponent(installationId)}/destinations`,
      itemsParser(parseDestination, "destinations"),
      { signal },
    ),
  createDestination: (
    workspaceId: string,
    installationId: string,
    input: { url: string; description?: string; eventTypes?: string[] },
    signal?: AbortSignal,
  ) =>
    hostedRequest(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/installations/${encodeURIComponent(installationId)}/destinations`,
      parseDestination,
      { method: "POST", body: JSON.stringify(input), signal },
    ),
  publish: (
    workspaceId: string,
    input: { installationId: string; eventType: string; payload: Record<string, unknown> },
    signal?: AbortSignal,
  ) =>
    hostedRequest(`/v1/workspaces/${encodeURIComponent(workspaceId)}/events`, parsePublish, {
      method: "POST",
      body: JSON.stringify(input),
      signal,
      headers: { "Idempotency-Key": idempotencyKey("publish", input.installationId) },
    }),
  deliveries: (workspaceId: string, signal?: AbortSignal) =>
    hostedRequest(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/deliveries`,
      itemsParser(parseDelivery, "deliveries"),
      { signal },
    ),
  replay: (workspaceId: string, deliveryId: string, reason: string, signal?: AbortSignal) =>
    hostedRequest(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
      passThrough,
      { method: "POST", body: JSON.stringify({ reason }), signal },
    ),
  members: (workspaceId: string, signal?: AbortSignal) =>
    hostedRequest(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/members`,
      itemsParser(parseMember, "members"),
      { signal },
    ),
  invite: (
    workspaceId: string,
    input: { email: string; role: "admin" | "operator" | "viewer" },
    signal?: AbortSignal,
  ) =>
    hostedRequest(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
      parseInvitation,
      { method: "POST", body: JSON.stringify(input), signal },
    ),
  apiKeys: (workspaceId: string, signal?: AbortSignal) =>
    hostedRequest(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/api-keys`,
      itemsParser(parseApiKey, "apiKeys"),
      { signal },
    ),
  createApiKey: (
    workspaceId: string,
    input: {
      name: string;
      permissions?: {
        events?: ApiKeyPermission;
        destinations?: ApiKeyPermission;
        deliveries?: ApiKeyPermission;
        replay?: ApiKeyPermission;
      };
    },
    signal?: AbortSignal,
  ) =>
    hostedRequest(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/api-keys`,
      parseApiKey,
      { method: "POST", body: JSON.stringify(input), signal },
    ),
  revokeApiKey: (workspaceId: string, keyId: string, signal?: AbortSignal) =>
    hostedRequest(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/api-keys/${encodeURIComponent(keyId)}`,
      passThrough,
      { method: "DELETE", signal },
    ),
};

export type EventItem = {
  id: string;
  provider: string;
  topic: string;
  signatureStatus: string;
  receivedAt: string;
  payload: Record<string, unknown>;
};
export type ActionItem = {
  id: string;
  title: string;
  type: string;
  risk: string;
  status: string;
  diff?: string;
  requiredCapabilities: string[];
};
export type RunItem = {
  id: string;
  status: string;
  summary?: string;
  startedAt: string;
  threadId?: string;
};
export type AuditItem = { id: string; kind: string; message: string; createdAt: string };
export type MemoryItem = { id: string; text: string; tags: string[]; createdAt: string };
export type ConnectorItem = { provider: string; status: string; capabilities: string[] };
export type ForgeItem = {
  id: string;
  prompt: string;
  status: string;
  requestedScopes: string[];
  validation: { passed: boolean; findings: string[] };
  generatedFiles: Array<{ path: string; content: string }>;
};
export type InstallationItem = {
  id: string;
  workspaceId: string;
  provider: string;
  installationKey: string;
  status: string;
};
export type DestinationItem = {
  id: string;
  workspaceId: string;
  installationId: string;
  url: string;
  description: string;
  eventTypes: string[];
  channels: string[];
  maxRatePerSecond: number;
  mode: string;
  status: string;
  secretHint: string;
  secret?: string;
};
export type PublishResult = {
  accepted: boolean;
  duplicate: boolean;
  eventId: string;
  deliveryIds: string[];
  matchedDestinationCount: number;
};
export type DeliveryLogItem = {
  id: string;
  status: string;
  eventId?: string;
  destinationId?: string;
  attemptsCount: number;
  safeReason?: string;
  createdAt: string;
};
export type MemberItem = {
  identityId: string;
  email: string;
  role: string;
  createdAt: string;
};
export type InvitationItem = {
  id: string;
  workspaceId: string;
  email: string;
  role: string;
  identityId?: string;
  acceptedAt?: string;
};
export type ApiKeyPermission = "none" | "read" | "write";
export type ApiKeyItem = {
  id: string;
  workspaceId: string;
  name: string;
  prefix: string;
  permissions: {
    events: ApiKeyPermission;
    destinations: ApiKeyPermission;
    deliveries: ApiKeyPermission;
    replay: ApiKeyPermission;
  };
  lastUsedAt?: string;
  createdAt: string;
  token?: string;
};
