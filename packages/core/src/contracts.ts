import { z } from "zod";

export const ProviderSchema = z.enum(["github", "linear", "sentry", "custom"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const RuntimeModeSchema = z.enum(["local", "remote", "test"]);
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

export const WorkspaceRoleSchema = z.enum(["owner", "admin", "operator", "viewer"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

export const McpScopeSchema = z.enum([
  "eventforge:read",
  "eventforge:operate",
  "eventforge:approve",
  "eventforge:forge",
  "eventforge:install",
]);
export type McpScope = z.infer<typeof McpScopeSchema>;

export const AuthContextSchema = z.object({
  actorId: z.string().min(1),
  workspaceId: z.string().min(1),
  role: WorkspaceRoleSchema,
  sessionId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  mfaVerified: z.boolean().default(false),
  /** Absolute proof timestamp; normal requests must never refresh this value. */
  mfaVerifiedAt: z.string().datetime().optional(),
  scopes: z.array(McpScopeSchema).default([]),
});
export type AuthContext = z.infer<typeof AuthContextSchema>;

export const ManagedTunnelLeaseSchema = z.object({
  tunnelId: z.string().uuid(),
  tunnelName: z.string().min(1),
  hostname: z.string().min(1),
  publicUrl: z.string().url(),
  token: z.string().min(32),
});
export type ManagedTunnelLease = z.infer<typeof ManagedTunnelLeaseSchema>;

export const LocalRelayStatusSchema = z.object({
  state: z.enum(["stopped", "starting", "ready", "failed"]),
  provider: z.enum(["github", "linear", "sentry"]).optional(),
  endpoint: z.string().url().optional(),
  publicUrl: z.string().url().optional(),
  tunnelName: z.string().optional(),
  error: z.string().optional(),
});
export type LocalRelayStatus = z.infer<typeof LocalRelayStatusSchema>;

export const EventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  provider: ProviderSchema,
  topic: z.string().min(1),
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  environmentId: z.string().uuid().optional(),
  repository: z.string().min(1).optional(),
  occurredAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  signatureStatus: z.enum(["verified", "demo", "unverified"]),
  dedupeKey: z.string().min(1),
  providerDeliveryId: z.string().min(1).optional(),
  payloadStorage: z.enum(["inline", "r2_encrypted", "metadata_only"]).default("inline"),
  payloadChecksum: z.string().min(1).optional(),
  payload: z.record(z.unknown()),
  payloadRef: z.string().optional(),
  redactions: z.array(z.string()).default([]),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const IssueReviewModeSchema = z.enum(["review_only", "authorized_implementation"]);
export type IssueReviewMode = z.infer<typeof IssueReviewModeSchema>;

export const IssueReviewAssessmentSchema = z.object({
  mode: z.literal("review_only"),
  status: z.enum(["assessed", "safely_failed"]),
  requestSummary: z.string().max(500),
  affectedAreas: z.array(z.string()).max(5),
  riskNotes: z.array(z.string()).max(5),
  missingInformation: z.array(z.string()).max(5),
  safeNextStep: z.string().max(300),
  actorClassification: z.literal("untrusted"),
  policyVersion: z.literal(1),
  auditEventIdHash: z.string().length(64),
  reason: z.string().max(200).optional(),
});
export type IssueReviewAssessment = z.infer<typeof IssueReviewAssessmentSchema>;

export const ApprovalModeSchema = z.enum(["approval_required", "allow_listed_writes"]);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const ExecutionPolicySchema = z.object({
  version: z.number().int().positive().default(1),
  approvalMode: ApprovalModeSchema.default("approval_required"),
  allowedCapabilities: z
    .array(
      z.enum(["read", "write_files", "git_commit", "provider_write", "network", "install_plugin"]),
    )
    .default(["read"]),
  allowedRepositories: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).default([]),
  allowedDomains: z.array(z.string()).default([]),
  allowedProviders: z.array(ProviderSchema).default([]),
});
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

export const PolicyRequestSchema = z.object({
  actor: AuthContextSchema,
  provider: ProviderSchema.optional(),
  repository: z.string().optional(),
  paths: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  capabilities: z.array(z.string()).default([]),
});
export type PolicyRequest = z.infer<typeof PolicyRequestSchema>;

export const PolicyDecisionSchema = z.object({
  allowed: z.boolean(),
  requiresApproval: z.boolean(),
  policyVersion: z.number().int().positive(),
  policyDigest: z.string().length(64),
  schemaVersion: z.number().int().positive(),
  evaluatorVersion: z.string().min(1),
  contextDigest: z.string().length(64),
  outcome: z.enum(["allow", "deny", "approval_required", "invalid", "unmatched"]),
  matchedRuleIds: z.array(z.string()),
  reasonCodes: z.array(z.string()),
  scope: z.object({ workspaceId: z.string().min(1) }),
  uncertainty: z.array(z.string()),
  reasons: z.array(z.string()),
  resources: z.object({
    provider: ProviderSchema.optional(),
    repository: z.string().optional(),
    paths: z.array(z.string()),
    domains: z.array(z.string()),
    capabilities: z.array(z.string()),
  }),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const PolicyPackStatusSchema = z.enum([
  "draft",
  "published",
  "active",
  "retired",
  "superseded",
]);
export type PolicyPackStatus = z.infer<typeof PolicyPackStatusSchema>;

export const PolicyPackManifestSchema = z.object({
  schemaVersion: z.literal(1),
  evaluatorVersion: z.string().min(1),
  workspaceId: z.string().min(1),
  packId: z.string().min(1),
  version: z.number().int().positive(),
  policy: ExecutionPolicySchema,
  scopes: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  source: z.string().min(1),
});
export type PolicyPackManifest = z.infer<typeof PolicyPackManifestSchema>;

export const PolicySimulationStatusSchema = z.enum([
  "queued",
  "running",
  "complete",
  "partial",
  "blocked",
  "cancelled",
]);
export type PolicySimulationStatus = z.infer<typeof PolicySimulationStatusSchema>;

export type ProviderDeliveryInput = {
  rawBody: string;
  payload: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  secret?: string;
  now?: Date;
};

export type ProviderVerification = {
  verified: boolean;
  reason?: string;
  deliveryId?: string;
  topic?: string;
  occurredAt?: string;
  installationKey?: string;
};

export interface ProviderAdapter {
  readonly provider: Exclude<Provider, "custom">;
  verify(input: ProviderDeliveryInput): ProviderVerification;
  normalize(input: {
    workspaceId: string;
    projectId: string;
    payload: Record<string, unknown>;
    repository?: string;
    verification: ProviderVerification;
    signatureStatus: EventEnvelope["signatureStatus"];
  }): EventEnvelope;
}

export const WorkflowDefinitionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  trigger: z.object({ provider: ProviderSchema, topic: z.string().min(1) }),
  filters: z.record(z.unknown()).default({}),
  agentProfile: z.enum([
    "ci-investigator",
    "issue-triager",
    "pull-request-reviewer",
    "alert-responder",
    "custom",
  ]),
  memoryScope: z.enum(["project", "workspace"]),
  policy: ExecutionPolicySchema,
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const ActionProposalSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  eventId: z.string().uuid(),
  title: z.string().min(1),
  type: z.enum(["comment", "create_branch", "open_pull_request", "install_connector", "custom"]),
  risk: z.enum(["low", "medium", "high"]),
  requiredCapabilities: z.array(z.string()),
  resources: z
    .object({
      provider: ProviderSchema.optional(),
      repository: z.string().optional(),
      paths: z.array(z.string()).default([]),
      domains: z.array(z.string()).default([]),
    })
    .default({ paths: [], domains: [] }),
  policyVersion: z.number().int().positive().default(1),
  policySnapshotHash: z.string().min(1).default("legacy"),
  version: z.number().int().positive().default(1),
  diff: z.string().optional(),
  status: z.enum(["pending", "approved", "rejected", "expired", "executed", "failed"]),
  reviewer: z.string().optional(),
  decisionReason: z.string().optional(),
  decidedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  auditEventIds: z.array(z.string()).default([]),
});
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

export const AgentRunSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  eventId: z.string().uuid(),
  threadId: z.string().optional(),
  status: z.enum(["queued", "running", "waiting_for_approval", "completed", "failed"]),
  summary: z.string().optional(),
  structuredResult: z
    .object({
      summary: z.string(),
      findings: z.array(z.string()),
      risk: z.enum(["low", "medium", "high"]),
      requestedActions: z.array(z.string()),
      validation: z.array(z.string()),
      memoryUpdates: z.array(z.string()),
    })
    .optional(),
  memoryIds: z.array(z.string()).default([]),
  actionProposalId: z.string().uuid().optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const ForgeJobSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().min(1),
  prompt: z.string().min(8),
  status: z.enum(["draft", "validated", "rejected", "approved", "installed"]),
  requestedScopes: z.array(z.string()),
  artifactPath: z.string().optional(),
  generatedFiles: z.array(z.object({ path: z.string(), content: z.string() })),
  validation: z.object({ passed: z.boolean(), findings: z.array(z.string()) }),
  createdAt: z.string().datetime(),
  approvedBy: z.string().optional(),
});
export type ForgeJob = z.infer<typeof ForgeJobSchema>;

export type AuditEntry = {
  id: string;
  workspaceId: string;
  kind:
    | "event_received"
    | "workflow_matched"
    | "agent_run"
    | "issue_review"
    | "approval"
    | "forge"
    | "connector"
    | "hermes_tool";
  subjectId: string;
  message: string;
  createdAt: string;
};

export interface EventRepository {
  appendEvent(event: EventEnvelope): { created: boolean; event: EventEnvelope };
  events(workspaceId?: string): EventEnvelope[];
  eventById(id: string): EventEnvelope | undefined;
}

export interface WorkflowRepository {
  workflows(workspaceId?: string): WorkflowDefinition[];
  workflowById(id: string): WorkflowDefinition | undefined;
  addWorkflow(workflow: WorkflowDefinition): WorkflowDefinition;
}

export interface ActionRepository {
  actions(workspaceId?: string): ActionProposal[];
  actionById(id: string): ActionProposal | undefined;
  addAction(action: ActionProposal): ActionProposal;
}

export interface AuditRepository {
  auditEntries(workspaceId?: string): AuditEntry[];
  audit(
    workspaceId: string,
    kind: AuditEntry["kind"],
    subjectId: string,
    message: string,
  ): AuditEntry;
}

export interface StoreTransaction {
  events: EventRepository;
  workflows: WorkflowRepository;
  actions: ActionRepository;
  audit: AuditRepository;
}
