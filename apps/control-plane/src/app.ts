import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import rawBody from "fastify-raw-body";
import Fastify, { type FastifyInstance } from "fastify";
import { RateLimiterMemory, type RateLimiterRes } from "rate-limiter-flexible";
import { z } from "zod";
import {
  EventForgeStore,
  ExecutionPolicySchema,
  WorkflowDefinitionSchema,
  createForgeDraft,
  demoEvents,
  githubPullRequestNumber,
  assessGitHubIssueEvent,
  isGitHubCiFailure,
  isGitHubIssueEvent,
  isGitHubPullRequestReviewEvent,
  matchesWorkflow,
  normalizeEvent,
  evaluatePolicy,
  providerAdapters,
  type ActionProposal,
  type AuthContext,
  type EventEnvelope,
  type Provider,
  type WorkflowDefinition,
} from "@eventforge/core";
import { createRunner, type AgentRunner } from "./runner.js";
import { PostgresAuditSink } from "./postgres-audit.js";
import {
  createAutomationAuthContext,
  FixedWindowLimiter,
  resolveRuntimeConfig,
  type RequestAuthenticator,
} from "./runtime.js";
import type { RelayController } from "./local-relay.js";
import type { TunnelProvisioner } from "./managed-tunnel.js";
import { GitHubInstallationRegistry, type GitHubInstallation } from "./github-app.js";
import { createNotifierFromEnv, type NotificationStatus, type WebhookNotifier } from "./notify.js";
import type { StateStoreStatus } from "./state-sync.js";

/**
 * Deterministic UUID for a built-in workflow so persisted runs and proposals keep
 * pointing at the same workflow after a restart.
 */
export function builtinWorkflowId(workspaceId: string, key: string): string {
  const hex = createHash("sha256").update(`eventforge-builtin:${workspaceId}:${key}`).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const DEFAULT_WORKSPACE = "demo-workspace";
const DEFAULT_PROJECT = "eventforge-demo-service";
const LOCAL_CONSOLE_ORIGIN = "http://localhost:5173";
const RECENT_MFA_WINDOW_MS = 15 * 60 * 1000;
const DEMO_REPOSITORY = "eventforge/demo-service";
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const PROPOSAL_PENDING_NOTE =
  "A remediation proposal is waiting for approval; no write has been performed.";

/**
 * Repositories the built-in GitHub workflows may propose writes for. Explicit
 * EVENTFORGE_ALLOWED_REPOS (comma separated) wins; otherwise the configured
 * EVENTFORGE_GITHUB_REPOSITORY; otherwise the bundled demo repository. The demo
 * repository stays allowed while demo mode is on so `/events/demo` keeps working.
 */
export function configuredAllowedRepositories(environment = process.env): string[] {
  const explicit = (environment.EVENTFORGE_ALLOWED_REPOS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = explicit.filter((item) => !REPOSITORY_PATTERN.test(item));
  if (invalid.length)
    throw new Error("EVENTFORGE_ALLOWED_REPOS must list OWNER/REPOSITORY entries.");
  const configured = environment.EVENTFORGE_GITHUB_REPOSITORY?.trim();
  const base = explicit.length
    ? explicit
    : configured && REPOSITORY_PATTERN.test(configured)
      ? [configured]
      : [DEMO_REPOSITORY];
  const demo = environment.EVENTFORGE_DEMO_MODE === "true" || environment.NODE_ENV === "test";
  return [...new Set(demo ? [...base, DEMO_REPOSITORY] : base)];
}

/** Optional workflow-name filter for GitHub Actions `workflow_run` failures. */
export function configuredCiWorkflowNames(environment = process.env): string[] {
  return (environment.EVENTFORGE_CI_WORKFLOWS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function bearerMatches(header: unknown, token: string): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function eventLink(event: EventEnvelope): string | null {
  const payload = event.payload;
  for (const key of ["workflow_run", "check_run", "pull_request", "issue"]) {
    const value = payload[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const url = (value as Record<string, unknown>).html_url;
      if (typeof url === "string" && url.startsWith("https://")) return url;
    }
  }
  return null;
}

type IntegrationBinding = {
  provider: Exclude<Provider, "custom">;
  installationKey: string;
  repository?: string;
  workspaceId: string;
  projectId: string;
};
export type AppOptions = {
  store?: EventForgeStore;
  runner?: AgentRunner;
  persistAudit?: boolean;
  authenticate?: RequestAuthenticator;
  integrations?: IntegrationBinding[];
  relayController?: RelayController;
  tunnelProvisioner?: TunnelProvisioner;
  githubInstallations?: GitHubInstallationRegistry;
  /** Outbound signed run notifications. Defaults to EVENTFORGE_NOTIFY_URL/SECRET when unset. */
  notifier?: WebhookNotifier | null;
  /** Durable store status for /health (EVENTFORGE_STORE=cloudflare). */
  stateStatus?: () => StateStoreStatus;
};

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string | Buffer;
  }
}

export function configuredBrowserOrigins(
  value = process.env.EVENTFORGE_ALLOWED_ORIGINS,
  environment = process.env.NODE_ENV,
): string[] {
  const origins =
    value
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [];
  if (origins.length > 0) return origins;
  if (environment === "production")
    throw new Error("EVENTFORGE_ALLOWED_ORIGINS must list the production console origin.");
  return [LOCAL_CONSOLE_ORIGIN];
}

export function isLoopbackRequestHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export function hasRecentMfa(auth: AuthContext, now = Date.now()): boolean {
  if (!auth.mfaVerified || !auth.mfaVerifiedAt) return false;
  const verifiedAt = Date.parse(auth.mfaVerifiedAt);
  return (
    Number.isFinite(verifiedAt) && verifiedAt <= now && now - verifiedAt <= RECENT_MFA_WINDOW_MS
  );
}

function isPublicRelayPath(url: string): boolean {
  const pathname = new URL(url, "http://localhost").pathname;
  return pathname === "/health" || /^\/webhooks\/(github|linear|sentry)$/.test(pathname);
}

export function createDefaultWorkflow(
  allowedRepositories: string[] = configuredAllowedRepositories(),
): WorkflowDefinition {
  return {
    id: randomUUID(),
    workspaceId: DEFAULT_WORKSPACE,
    projectId: DEFAULT_PROJECT,
    name: "Investigate GitHub CI failures",
    enabled: true,
    trigger: { provider: "github", topic: "check_run" },
    filters: { "check_run.conclusion": "failure" },
    agentProfile: "ci-investigator",
    memoryScope: "project",
    policy: {
      version: 1,
      approvalMode: "approval_required",
      allowedCapabilities: ["read", "write_files", "git_commit", "provider_write"],
      allowedRepositories,
      allowedPaths: ["src/**", "test/**"],
      allowedDomains: ["api.github.com"],
      allowedProviders: ["github"],
    },
  };
}

export function createWorkflowRunFailureWorkflow(
  allowedRepositories: string[] = configuredAllowedRepositories(),
  workflowNames: string[] = configuredCiWorkflowNames(),
): WorkflowDefinition {
  const base = createDefaultWorkflow(allowedRepositories);
  return {
    ...base,
    id: randomUUID(),
    name: "Investigate GitHub Actions workflow failures",
    trigger: { provider: "github", topic: "workflow_run" },
    filters: {
      action: "completed",
      "workflow_run.conclusion": "failure",
      ...(workflowNames.length ? { "workflow_run.name": workflowNames } : {}),
    },
  };
}

function createIssueReviewWorkflow(
  topic: "issues" | "issue_comment",
  allowedRepositories: string[],
): WorkflowDefinition {
  return {
    id: randomUUID(),
    workspaceId: DEFAULT_WORKSPACE,
    projectId: DEFAULT_PROJECT,
    name: topic === "issues" ? "Review GitHub issues" : "Review GitHub issue comments",
    enabled: true,
    trigger: { provider: "github", topic },
    filters: {},
    agentProfile: "issue-triager",
    memoryScope: "project",
    policy: {
      version: 1,
      approvalMode: "approval_required",
      allowedCapabilities: ["read"],
      allowedRepositories,
      allowedPaths: ["**"],
      allowedDomains: [],
      allowedProviders: ["github"],
    },
  };
}

function createPullRequestReviewWorkflow(allowedRepositories: string[]): WorkflowDefinition {
  return {
    id: randomUUID(),
    workspaceId: DEFAULT_WORKSPACE,
    projectId: DEFAULT_PROJECT,
    name: "Review GitHub pull request updates",
    enabled: true,
    trigger: { provider: "github", topic: "pull_request" },
    filters: { action: ["opened", "reopened", "synchronize"] },
    agentProfile: "pull-request-reviewer",
    memoryScope: "project",
    policy: {
      version: 1,
      approvalMode: "approval_required",
      allowedCapabilities: ["read"],
      allowedRepositories,
      allowedPaths: ["**"],
      allowedDomains: [],
      allowedProviders: ["github"],
    },
  };
}

function secretFor(provider: Provider): string | undefined {
  if (provider === "github") return process.env.GITHUB_WEBHOOK_SECRET;
  if (provider === "linear") return process.env.LINEAR_WEBHOOK_SECRET;
  if (provider === "sentry") return process.env.SENTRY_WEBHOOK_SECRET;
  return undefined;
}

const SUPPORTED_HOSTED_GITHUB_EVENTS = new Set(["check_run", "issues", "pull_request"]);

function githubRepositoryName(payload: Record<string, unknown>): string | undefined {
  const repository = payload.repository;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) return undefined;
  const fullName = (repository as Record<string, unknown>).full_name;
  if (
    typeof fullName !== "string" ||
    fullName.length > 201 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)
  )
    return undefined;
  return fullName;
}

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const runtime = resolveRuntimeConfig(process.env, Boolean(options.authenticate));
  if (runtime.githubAppEnabled && !options.githubInstallations)
    throw new Error("Hosted GitHub App ingress requires a server-side installation registry.");
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: runtime.bodyLimit,
    requestIdHeader: "x-request-id",
  });
  const store = options.store ?? new EventForgeStore();
  const runner = options.runner ?? createRunner();
  const auditSink =
    options.persistAudit !== false && process.env.DATABASE_URL
      ? new PostgresAuditSink(process.env.DATABASE_URL)
      : undefined;
  const requestLimiter = new RateLimiterMemory({
    points: runtime.rateLimitPerMinute,
    duration: 60,
  });
  const agentLimiter = new FixedWindowLimiter(runtime.agentRunsPerHour, 60 * 60_000);
  const authContexts = new WeakMap<object, AuthContext>();
  const idempotentDecisions = new Map<string, ActionProposal>();
  const allowedOrigins = configuredBrowserOrigins();
  const allowedRepositories = configuredAllowedRepositories();
  const apiToken = runtime.mode === "remote" ? undefined : process.env.EVENTFORGE_API_TOKEN;
  const notifier =
    options.notifier === undefined ? createNotifierFromEnv(process.env, app.log) : options.notifier;
  // Built-ins are defined by configuration: stable ids, and the current config replaces
  // any persisted copy on startup (policy edits to a built-in last until restart).
  const builtin = (key: string, workflow: WorkflowDefinition) =>
    store.addWorkflow({ ...workflow, id: builtinWorkflowId(workflow.workspaceId, key) });
  builtin("ci-check-run", createDefaultWorkflow(allowedRepositories));
  builtin("ci-workflow-run", createWorkflowRunFailureWorkflow(allowedRepositories));
  builtin("issues", createIssueReviewWorkflow("issues", allowedRepositories));
  builtin("issue-comments", createIssueReviewWorkflow("issue_comment", allowedRepositories));
  builtin("pull-requests", createPullRequestReviewWorkflow(allowedRepositories));

  await app.register(cors, {
    origin: (origin, callback) =>
      callback(null, origin === undefined || allowedOrigins.includes(origin)),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "idempotency-key", "x-csrf-token"],
    maxAge: 86_400,
  });
  await app.register(rawBody, { global: false, encoding: false, runFirst: true });
  const unsubscribeAudit = auditSink
    ? store.subscribeAudit((entry) =>
        auditSink
          .append(entry)
          .catch((error: unknown) =>
            app.log.error({ err: error, auditId: entry.id }, "audit persistence failed"),
          ),
      )
    : undefined;
  app.addHook("onRequest", async (request, reply) => {
    if (
      runtime.mode !== "remote" &&
      !isLoopbackRequestHost(request.hostname) &&
      !isPublicRelayPath(request.url)
    ) {
      return reply.status(404).send({ error: "Not found." });
    }
    try {
      await requestLimiter.consume(request.ip);
    } catch (rate) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(((rate as RateLimiterRes).msBeforeNext ?? 1_000) / 1_000),
      );
      return reply
        .header("retry-after", retryAfterSeconds)
        .status(429)
        .send({ error: "Request rate limit exceeded." });
    }
  });
  app.addHook("onRequest", async (request, reply) => {
    // Optional local bearer token: protects the plane from other local users and processes.
    // Provider webhooks authenticate with their own HMAC signatures instead.
    if (!apiToken || isPublicRelayPath(request.url) || request.method === "OPTIONS") return;
    if (!bearerMatches(request.headers.authorization, apiToken))
      return reply.status(401).send({ error: "EventForge API token required." });
  });
  app.addHook("onRequest", async (request, reply) => {
    if (
      runtime.mode !== "remote" ||
      request.url === "/health" ||
      request.url.startsWith("/webhooks/")
    )
      return;
    const auth = await options.authenticate?.(request);
    if (!auth || !hasRecentMfa(auth))
      return reply.status(401).send({ error: "Authenticated MFA session required." });
    authContexts.set(request, auth);
    if (request.method === "GET" && !auth.scopes.includes("eventforge:read")) {
      return reply.status(403).send({ error: "eventforge:read scope required." });
    }
  });
  app.addHook("onClose", async () => {
    unsubscribeAudit?.();
    await auditSink?.close();
  });

  function authFor(request: object, workspaceId = DEFAULT_WORKSPACE): AuthContext {
    return (
      authContexts.get(request) ?? {
        actorId: "local-owner",
        workspaceId,
        role: "owner",
        mfaVerified: runtime.mode !== "remote",
        mfaVerifiedAt: runtime.mode !== "remote" ? new Date().toISOString() : undefined,
        scopes: [
          "eventforge:read",
          "eventforge:operate",
          "eventforge:approve",
          "eventforge:forge",
          "eventforge:install",
        ],
      }
    );
  }

  function scopedWorkspace(request: object, requested?: string): string | undefined {
    return runtime.mode === "remote" ? authFor(request).workspaceId : requested;
  }

  function ownsWorkspace(request: object, workspaceId: string): boolean {
    return runtime.mode !== "remote" || authFor(request).workspaceId === workspaceId;
  }

  function notifyRun(runId: string, status: NotificationStatus): void {
    if (!notifier) return;
    try {
      const run = store.runs().find((candidate) => candidate.id === runId);
      if (!run) return;
      const event = store.eventById(run.eventId);
      if (!event) return;
      const proposal = run.actionProposalId ? store.actionById(run.actionProposalId) : undefined;
      notifier.notify({
        event: {
          id: event.id,
          provider: event.provider,
          topic: event.topic,
          deliveryId: event.providerDeliveryId,
          signatureStatus: event.signatureStatus,
        },
        run: {
          id: run.id,
          workflowId: run.workflowId,
          status: run.status,
          summary: run.summary,
        },
        proposal: proposal
          ? { id: proposal.id, title: proposal.title, status: proposal.status, type: proposal.type }
          : null,
        repo: event.repository ?? null,
        status,
        link: eventLink(event),
      });
    } catch (error) {
      app.log.warn({ err: error, runId }, "run notification could not be queued");
    }
  }

  async function runWorkflow(workflow: WorkflowDefinition, event: EventEnvelope): Promise<void> {
    store.audit(
      event.workspaceId,
      "workflow_matched",
      workflow.id,
      `${workflow.name} matched ${event.provider}:${event.topic}.`,
    );
    const run = store.addRun({
      id: randomUUID(),
      workflowId: workflow.id,
      eventId: event.id,
      status: "running",
      memoryIds: [],
      startedAt: new Date().toISOString(),
    });
    store.audit(event.workspaceId, "agent_run", run.id, "Agent investigation started.");
    try {
      // Issue content is never an authorization signal. Keep its deterministic assessment
      // ahead of memory retrieval, model execution, policy evaluation, and provider actions.
      if (isGitHubIssueEvent(event)) {
        const assessment = assessGitHubIssueEvent(event);
        store.updateRun(run.id, {
          summary: assessment.requestSummary,
          status: assessment.status === "assessed" ? "completed" : "failed",
          finishedAt: new Date().toISOString(),
        });
        store.audit(
          event.workspaceId,
          "issue_review",
          assessment.auditEventIdHash,
          `GitHub issue review ${assessment.status}; mode=review_only; reason=${assessment.reason ?? "assessed"}.`,
        );
        return;
      }
      const memories = store.memory
        .query(event.workspaceId, event.projectId, JSON.stringify(event.payload))
        .map((memory) => memory.text);
      const pullRequestNumber = githubPullRequestNumber(event);
      const previousThreadId = store.runs().find((candidate) => {
        if (candidate.workflowId !== workflow.id || candidate.id === run.id) return false;
        if (candidate.eventId === event.id) return true;
        if (pullRequestNumber === undefined) return false;
        const priorEvent = store.eventById(candidate.eventId);
        return (
          priorEvent !== undefined &&
          priorEvent?.repository === event.repository &&
          githubPullRequestNumber(priorEvent) === pullRequestNumber
        );
      })?.threadId;
      const result = await runner.investigate({
        event,
        workflow,
        memories,
        threadId: previousThreadId,
      });
      store.memory.remember({
        workspaceId: event.workspaceId,
        projectId: event.projectId,
        text: result.summary,
        tags: [event.provider, event.topic, "agent-summary"],
      });
      if (isGitHubPullRequestReviewEvent(event)) {
        store.updateRun(run.id, {
          threadId: result.threadId,
          summary: result.summary,
          structuredResult: result.structured,
          status: "completed",
          finishedAt: new Date().toISOString(),
        });
        store.audit(
          event.workspaceId,
          "agent_run",
          run.id,
          "Read-only Codex GitHub review completed; no provider action was proposed.",
        );
        return;
      }
      // A hosted GitHub App is investigation-only. Untrusted GitHub evidence must
      // never reach the generic write-proposal path, even after downstream changes.
      if (runtime.mode === "remote" && event.provider === "github") {
        store.updateRun(run.id, {
          threadId: result.threadId,
          summary: result.summary,
          structuredResult: result.structured,
          status: "completed",
          finishedAt: new Date().toISOString(),
        });
        store.audit(
          event.workspaceId,
          "agent_run",
          run.id,
          "Hosted GitHub investigation completed read-only.",
        );
        return;
      }
      const capabilities = ["write_files", "git_commit", "provider_write"];
      const repository = event.repository;
      const decision = evaluatePolicy(workflow.policy, {
        actor: createAutomationAuthContext(event.workspaceId),
        provider: event.provider,
        repository,
        paths: [],
        domains: event.provider === "github" ? ["api.github.com"] : [],
        capabilities,
      });
      if (!decision.allowed) {
        store.updateRun(run.id, {
          threadId: result.threadId,
          summary: `${result.summary} Policy denied the proposal: ${decision.reasons.join(" ")}`,
          structuredResult: result.structured,
          status: "completed",
          finishedAt: new Date().toISOString(),
        });
        store.audit(
          event.workspaceId,
          "agent_run",
          run.id,
          "Agent analysis completed; policy denied creation of a write proposal.",
        );
        return;
      }
      const policySnapshotHash = decision.policyDigest;
      const proposal: ActionProposal = {
        id: randomUUID(),
        workflowId: workflow.id,
        eventId: event.id,
        title: isGitHubCiFailure(event)
          ? "Create a remediation branch and PR proposal"
          : "Create a reviewed remediation proposal",
        type: isGitHubCiFailure(event) ? "open_pull_request" : "custom",
        risk: "medium",
        requiredCapabilities: capabilities,
        resources: {
          provider: event.provider,
          repository,
          paths: [],
          domains: decision.resources.domains,
        },
        policyVersion: decision.policyVersion,
        policySnapshotHash,
        version: 1,
        diff: "# Proposed remediation\n\n1. Reproduce the failure.\n2. Add a focused regression test.\n3. Prepare a branch and pull request after approval.",
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        auditEventIds: [],
      };
      store.addAction(proposal);
      store.updateRun(run.id, {
        threadId: result.threadId,
        summary: `${result.summary} ${PROPOSAL_PENDING_NOTE}`,
        structuredResult: result.structured,
        actionProposalId: proposal.id,
        status: "waiting_for_approval",
        finishedAt: new Date().toISOString(),
      });
      store.audit(
        event.workspaceId,
        "agent_run",
        run.id,
        "Agent analysis completed; write proposal is waiting for approval.",
      );
    } catch (error) {
      store.updateRun(run.id, {
        status: "failed",
        summary: error instanceof Error ? error.message : "Unknown runner failure",
        finishedAt: new Date().toISOString(),
      });
      store.audit(event.workspaceId, "agent_run", run.id, "Agent investigation failed.");
    } finally {
      const finalStatus = store.runs().find((candidate) => candidate.id === run.id)?.status;
      if (
        finalStatus === "completed" ||
        finalStatus === "waiting_for_approval" ||
        finalStatus === "failed"
      )
        notifyRun(run.id, finalStatus);
    }
  }

  async function ingest(
    provider: Provider,
    payload: Record<string, unknown>,
    input: {
      signatureStatus: EventEnvelope["signatureStatus"];
      deliveryId?: string;
      topicHint?: string;
      workspaceId?: string;
      projectId?: string;
      repository?: string;
      awaitWorkflows?: boolean;
    },
  ) {
    const event = normalizeEvent({
      provider,
      payload,
      signatureStatus: input.signatureStatus,
      deliveryId: input.deliveryId,
      topicHint: input.topicHint,
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE,
      projectId: input.projectId ?? DEFAULT_PROJECT,
      repository: input.repository,
    });
    const appended = store.appendEvent(event);
    if (!appended.created) return { duplicate: true, event: appended.event, runs: [] };
    const workflows = store
      .workflows(event.workspaceId)
      .filter((workflow) => matchesWorkflow(workflow, event));
    const execution = Promise.all(workflows.map((workflow) => runWorkflow(workflow, event)));
    if (input.awaitWorkflows !== false) {
      await execution;
    } else {
      void execution.catch((error: unknown) =>
        app.log.error({ err: error, eventId: event.id }, "background workflow execution failed"),
      );
    }
    return {
      duplicate: false,
      event,
      runs: store.runs().filter((run) => run.eventId === event.id),
    };
  }

  app.get("/health", async () => ({
    ok: true,
    service: "eventforge-control-plane",
    runtime: runtime.mode,
    runner: process.env.EVENTFORGE_RUNNER ?? "demo",
    store: options.stateStatus?.() ?? { mode: "memory" },
  }));
  app.get("/events", async (request) =>
    store.events(scopedWorkspace(request, (request.query as { workspaceId?: string }).workspaceId)),
  );
  app.get("/workflows", async (request) =>
    store.workflows(
      scopedWorkspace(request, (request.query as { workspaceId?: string }).workspaceId),
    ),
  );
  app.get("/runs", async (request) => {
    const workspaceId = scopedWorkspace(request);
    return workspaceId
      ? store
          .runs()
          .filter((run) => store.workflowById(run.workflowId)?.workspaceId === workspaceId)
      : store.runs();
  });
  app.get("/actions", async (request) =>
    store.actions(
      scopedWorkspace(request, (request.query as { workspaceId?: string }).workspaceId),
    ),
  );
  app.get("/audit", async (request) =>
    store.auditEntries(
      scopedWorkspace(request, (request.query as { workspaceId?: string }).workspaceId),
    ),
  );
  app.post("/audit", async (request, reply) => {
    const parsed = z
      .object({
        kind: z.literal("hermes_tool"),
        subjectId: z.string().min(1).max(200),
        message: z.string().min(1).max(500),
        workspaceId: z.string().min(1).default(DEFAULT_WORKSPACE),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    if (!ownsWorkspace(request, parsed.data.workspaceId))
      return reply
        .status(403)
        .send({ error: "Cannot write an audit entry into another workspace." });
    if (
      runtime.mode === "remote" &&
      !authFor(request, parsed.data.workspaceId).scopes.includes("eventforge:operate")
    ) {
      return reply.status(403).send({ error: "eventforge:operate scope required." });
    }
    const entry = store.audit(
      parsed.data.workspaceId,
      "hermes_tool",
      parsed.data.subjectId,
      parsed.data.message,
    );
    return reply.status(201).send(entry);
  });
  app.get("/memory", async (request) => {
    const query = request.query as { workspaceId?: string; projectId?: string; q?: string };
    return store.memory.query(
      scopedWorkspace(request, query.workspaceId) ?? DEFAULT_WORKSPACE,
      query.projectId ?? DEFAULT_PROJECT,
      query.q ?? "event",
    );
  });
  app.get("/connectors", async (request) => {
    const workspaceId = scopedWorkspace(request) ?? DEFAULT_WORKSPACE;
    const connected = (provider: IntegrationBinding["provider"]) =>
      options.integrations?.some(
        (binding) => binding.workspaceId === workspaceId && binding.provider === provider,
      );
    return [
      {
        provider: "github",
        status:
          runtime.mode === "remote"
            ? connected("github")
              ? "configured"
              : "unconfigured"
            : process.env.GITHUB_WEBHOOK_SECRET
              ? "configured"
              : "demo",
        capabilities: ["webhook", "read", "approval-gated write"],
      },
      {
        provider: "linear",
        status:
          runtime.mode === "remote"
            ? connected("linear")
              ? "configured"
              : "unconfigured"
            : process.env.LINEAR_CLIENT_ID
              ? "configured"
              : "demo",
        capabilities: ["webhook", "read"],
      },
      {
        provider: "sentry",
        status:
          runtime.mode === "remote"
            ? connected("sentry")
              ? "configured"
              : "unconfigured"
            : process.env.SENTRY_AUTH_TOKEN
              ? "configured"
              : "demo",
        capabilities: ["webhook", "read"],
      },
    ];
  });

  app.post("/workflows", async (request, reply) => {
    const actor = authFor(request);
    if (runtime.mode === "remote" && actor.role !== "owner")
      return reply.status(403).send({ error: "Owner role required." });
    const parsed = WorkflowDefinitionSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    if (!ownsWorkspace(request, parsed.data.workspaceId))
      return reply.status(403).send({ error: "Cannot create a workflow in another workspace." });
    return reply.status(201).send(store.addWorkflow(parsed.data));
  });
  app.patch("/workflows/:id/policy", async (request, reply) => {
    const workflow = store.workflowById((request.params as { id: string }).id);
    const parsed = ExecutionPolicySchema.safeParse(request.body);
    if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
    if (!ownsWorkspace(request, workflow.workspaceId))
      return reply.status(403).send({ error: "Cannot change another workspace policy." });
    if (runtime.mode === "remote" && authFor(request, workflow.workspaceId).role !== "owner")
      return reply.status(403).send({ error: "Owner role required." });
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return store.updateWorkflowPolicy(workflow.id, parsed.data);
  });

  app.post("/webhooks/:provider", { config: { rawBody: true } }, async (request, reply) => {
    const provider = z
      .enum(["github", "linear", "sentry"])
      .safeParse((request.params as { provider: string }).provider);
    if (!provider.success) return reply.status(404).send({ error: "Unknown provider" });
    const payload = request.body as Record<string, unknown>;
    if (!payload || typeof payload !== "object")
      return reply.status(400).send({ error: "Webhook body must be JSON." });
    if (runtime.mode === "remote" && provider.data === "github" && !runtime.githubAppEnabled)
      return reply.status(404).send({ error: "Hosted GitHub App ingress is disabled." });
    const secret = secretFor(provider.data);
    const raw = request.rawBody?.toString() ?? JSON.stringify(payload);
    const verification = providerAdapters[provider.data].verify({
      rawBody: raw,
      payload,
      headers: request.headers,
      secret,
    });
    if (!verification.verified)
      return reply
        .status(401)
        .send({ error: verification.reason ?? "Invalid or missing webhook signature." });
    if (
      runtime.mode === "remote" &&
      provider.data === "github" &&
      !SUPPORTED_HOSTED_GITHUB_EVENTS.has(verification.topic ?? "")
    )
      return reply.status(202).send({
        accepted: false,
        reason: "GitHub event is outside the hosted read-only allowlist.",
      });
    const binding =
      provider.data === "github"
        ? undefined
        : options.integrations?.find(
            (item) =>
              item.provider === provider.data &&
              item.installationKey === verification.installationKey,
          );
    const githubRepository = githubRepositoryName(payload);
    let githubInstallation: GitHubInstallation | undefined;
    let githubProjectId: string | undefined;
    if (runtime.mode === "remote" && provider.data === "github") {
      if (!verification.installationKey || !githubRepository) {
        app.log.warn(
          { reason: "malformed-installation-or-repository" },
          "GitHub delivery rejected before tenant mapping",
        );
        return reply.status(403).send({
          error: "Webhook installation is not an active attested repository mapping.",
        });
      }
      const resolution = options.githubInstallations!.resolve(
        verification.installationKey,
        githubRepository,
      );
      if (!resolution.ok) {
        app.log.warn(
          { reason: resolution.reason },
          "GitHub delivery rejected before tenant mapping",
        );
        return reply.status(403).send({
          error: "Webhook installation is not an active attested repository mapping.",
        });
      }
      githubInstallation = resolution.installation;
      githubProjectId = options.integrations?.find(
        (item) =>
          item.provider === "github" &&
          item.installationKey === verification.installationKey &&
          item.repository === githubRepository &&
          item.workspaceId === githubInstallation?.workspaceId,
      )?.projectId;
    }
    if (runtime.mode === "remote" && provider.data !== "github" && !binding)
      return reply
        .status(403)
        .send({ error: "Webhook installation is not mapped to a workspace." });
    const result = await ingest(provider.data, payload, {
      signatureStatus: "verified",
      deliveryId: verification.deliveryId,
      topicHint: verification.topic,
      workspaceId: githubInstallation?.workspaceId ?? binding?.workspaceId,
      projectId: githubProjectId ?? binding?.projectId,
      repository:
        runtime.mode === "remote"
          ? githubInstallation
            ? githubRepository
            : binding?.repository
          : provider.data === "github"
            ? // The HMAC-verified payload names the repository the event is about; the
              // workflow policy allowlist then decides whether a write may be proposed.
              githubRepository
            : undefined,
      awaitWorkflows: false,
    });
    return reply.status(result.duplicate ? 200 : 202).send(result);
  });

  app.post("/events/demo", async (request, reply) => {
    if (runtime.mode === "remote")
      return reply
        .status(403)
        .send({ error: "Demo event injection is unavailable in remote mode." });
    if (process.env.EVENTFORGE_DEMO_MODE !== "true" && process.env.NODE_ENV !== "test")
      return reply.status(403).send({ error: "Demo mode is disabled." });
    const provider = z
      .enum(["github", "linear", "sentry"])
      .default("github")
      .parse((request.body as { provider?: string } | undefined)?.provider);
    const payload =
      provider === "github"
        ? demoEvents.githubCiFailure
        : provider === "linear"
          ? demoEvents.linearIssue
          : demoEvents.sentryIssue;
    const topicHint =
      provider === "github" ? "check_run" : provider === "linear" ? "create" : "created";
    return reply.status(202).send(
      await ingest(provider, payload, {
        signatureStatus: "demo",
        deliveryId: `demo-${provider}-${Date.now()}`,
        topicHint,
        repository: provider === "github" ? "eventforge/demo-service" : undefined,
      }),
    );
  });
  app.post("/events", async (request, reply) => {
    if (runtime.mode === "remote" && !authFor(request).scopes.includes("eventforge:operate"))
      return reply.status(403).send({ error: "eventforge:operate scope required." });
    const parsed = z
      .object({
        provider: z.enum(["custom", "github", "linear", "sentry"]).default("custom"),
        topic: z.string().min(1),
        payload: z.record(z.unknown()),
        workspaceId: z.string().default(DEFAULT_WORKSPACE),
        projectId: z.string().default(DEFAULT_PROJECT),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    if (!ownsWorkspace(request, parsed.data.workspaceId))
      return reply.status(403).send({ error: "Cannot emit an event into another workspace." });
    return reply.status(202).send(
      await ingest(parsed.data.provider, parsed.data.payload, {
        signatureStatus: "unverified",
        topicHint: parsed.data.topic,
        workspaceId: parsed.data.workspaceId,
        projectId: parsed.data.projectId,
        deliveryId: `manual-${randomUUID()}`,
      }),
    );
  });
  app.post("/agent-runs", async (request, reply) => {
    const parsed = z
      .object({ workflowId: z.string().uuid(), eventId: z.string().uuid() })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const workflow = store.workflowById(parsed.data.workflowId);
    const event = store.eventById(parsed.data.eventId);
    if (!workflow || !event)
      return reply.status(404).send({ error: "Workflow or event not found" });
    if (
      !ownsWorkspace(request, workflow.workspaceId) ||
      !ownsWorkspace(request, event.workspaceId) ||
      event.workspaceId !== workflow.workspaceId
    ) {
      return reply.status(403).send({ error: "Cannot run an agent across workspace boundaries." });
    }
    if (
      runtime.mode === "remote" &&
      !authFor(request, workflow.workspaceId).scopes.includes("eventforge:operate")
    )
      return reply.status(403).send({ error: "eventforge:operate scope required." });
    const quota = agentLimiter.consume(
      `${authFor(request, workflow.workspaceId).workspaceId}:agent-runs`,
    );
    if (!quota.allowed)
      return reply
        .header("retry-after", quota.retryAfterSeconds)
        .status(429)
        .send({ error: "Agent-run quota exceeded." });
    await runWorkflow(workflow, event);
    return reply
      .status(202)
      .send(store.runs().find((run) => run.eventId === event.id && run.workflowId === workflow.id));
  });

  app.post("/actions/:id/decision", async (request, reply) => {
    const parsed = z
      .object({
        approved: z.boolean(),
        version: z.number().int().positive().optional(),
        reason: z.string().min(1).max(500).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const actionId = (request.params as { id: string }).id;
    const idempotencyKey = String(request.headers["idempotency-key"] ?? "");
    const idempotencyScope = idempotencyKey ? `${actionId}:${idempotencyKey}` : undefined;
    const action = store.actionById(actionId);
    if (!action) return reply.status(404).send({ error: "Action not found" });
    const workflow = store.workflowById(action.workflowId);
    if (!workflow) return reply.status(409).send({ error: "Action workflow no longer exists." });
    const actor = authFor(request, workflow.workspaceId);
    if (actor.workspaceId !== workflow.workspaceId || !["owner", "operator"].includes(actor.role)) {
      return reply.status(403).send({ error: "Actor cannot decide this workspace action." });
    }
    if (runtime.mode === "remote" && !actor.scopes.includes("eventforge:approve"))
      return reply.status(403).send({ error: "eventforge:approve scope required." });
    if (idempotencyScope && idempotentDecisions.has(idempotencyScope))
      return idempotentDecisions.get(idempotencyScope);
    if (workflow.policy.version !== action.policyVersion)
      return reply.status(409).send({ error: "Action was created under a stale policy version." });
    const policy = evaluatePolicy(workflow.policy, {
      actor,
      provider: action.resources.provider,
      repository: action.resources.repository,
      paths: action.resources.paths,
      domains: action.resources.domains,
      capabilities: action.requiredCapabilities,
    });
    if (!policy.allowed)
      return reply
        .status(403)
        .send({ error: "Current policy denies this action.", reasons: policy.reasons });
    const decided = store.decideAction(actionId, {
      approved: parsed.data.approved,
      reviewer: actor.actorId,
      expectedVersion: parsed.data.version,
      reason: parsed.data.reason,
    });
    if (decided.error === "not_found") return reply.status(404).send({ error: decided.message });
    if (decided.error)
      return reply.status(409).send({ error: decided.message, action: decided.value });
    const linkedRun = store.runs().find((run) => run.actionProposalId === actionId);
    if (linkedRun && decided.value) {
      const approved = decided.value.status === "approved";
      const outcome = approved
        ? "Proposal approved; execution remains pending a dedicated policy-controlled worker."
        : "Proposal rejected; no write was performed.";
      const analysis = (linkedRun.summary ?? "Agent analysis completed.")
        .replace(PROPOSAL_PENDING_NOTE, "")
        .trim();
      store.updateRun(linkedRun.id, {
        status: "completed",
        summary: `${analysis} ${outcome}`,
        finishedAt: new Date().toISOString(),
      });
      notifyRun(linkedRun.id, approved ? "approved" : "rejected");
    }
    if (idempotencyScope && decided.value) idempotentDecisions.set(idempotencyScope, decided.value);
    return decided.value;
  });

  app.post("/forge", async (request, reply) => {
    if (runtime.mode === "remote" && !authFor(request).scopes.includes("eventforge:forge"))
      return reply.status(403).send({ error: "eventforge:forge scope required." });
    const parsed = z
      .object({ workspaceId: z.string().default(DEFAULT_WORKSPACE), prompt: z.string().min(8) })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    if (!ownsWorkspace(request, parsed.data.workspaceId))
      return reply.status(403).send({ error: "Cannot forge in another workspace." });
    const job = store.addForge(createForgeDraft(parsed.data.workspaceId, parsed.data.prompt));
    store.audit(job.workspaceId, "forge", job.id, `Forge draft ${job.status}.`);
    return reply.status(job.status === "validated" ? 201 : 422).send(job);
  });
  app.get("/forge", async (request) =>
    store.forgeJobs(
      scopedWorkspace(request, (request.query as { workspaceId?: string }).workspaceId),
    ),
  );
  app.post("/forge/:id/decision", async (request, reply) => {
    const actor = authFor(request);
    if (
      runtime.mode === "remote" &&
      (actor.role !== "owner" || !actor.scopes.includes("eventforge:forge"))
    ) {
      return reply.status(403).send({ error: "Owner role and eventforge:forge scope required." });
    }
    const parsed = z.object({ approved: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const forgeId = (request.params as { id: string }).id;
    const existing = store.forgeById(forgeId);
    if (existing && !ownsWorkspace(request, existing.workspaceId))
      return reply.status(403).send({ error: "Cannot decide another workspace forge job." });
    const job = store.decideForge(forgeId, parsed.data.approved, actor.actorId);
    if (!job) return reply.status(404).send({ error: "Forge job not found" });
    return job;
  });

  app.get("/relay", async (_request, reply) => {
    if (runtime.mode === "remote")
      return reply.status(409).send({ error: "The local relay runs on the user's machine." });
    if (!options.relayController)
      return reply.status(503).send({ error: "Local relay controller is unavailable." });
    return options.relayController.status();
  });
  app.post("/relay/ensure", async (request, reply) => {
    if (runtime.mode === "remote")
      return reply.status(409).send({ error: "The local relay runs on the user's machine." });
    if (!options.relayController)
      return reply.status(503).send({ error: "Local relay controller is unavailable." });
    const parsed = z
      .object({ provider: z.enum(["github", "linear", "sentry"]) })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return await options.relayController.ensure(parsed.data.provider);
    } catch (error) {
      request.log.error({ err: error }, "local relay startup failed");
      return reply.status(502).send({ error: "Local relay failed to start." });
    }
  });
  app.post("/tunnels/provision", async (request, reply) => {
    if (!options.tunnelProvisioner)
      return reply.status(503).send({ error: "Managed tunnel provisioning is not configured." });
    const actor = authFor(request);
    if (actor.role !== "owner" || !actor.scopes.includes("eventforge:install"))
      return reply.status(403).send({ error: "Owner role and eventforge:install scope required." });
    const parsed = z
      .object({ originUrl: z.string().url().default("http://127.0.0.1:4310") })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const lease = await options.tunnelProvisioner.provision({
        actorId: actor.actorId,
        workspaceId: actor.workspaceId,
        originUrl: parsed.data.originUrl,
      });
      store.audit(
        actor.workspaceId,
        "connector",
        lease.tunnelId,
        `Owner provisioned managed relay ${lease.hostname}.`,
      );
      return reply.header("cache-control", "no-store").status(201).send(lease);
    } catch (error) {
      request.log.error({ err: error }, "managed tunnel provisioning failed");
      return reply.status(502).send({ error: "Managed tunnel provisioning failed." });
    }
  });

  return app;
}
