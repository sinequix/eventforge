import { randomUUID } from "node:crypto";
import type {
  ActionProposal,
  AgentRun,
  AuditEntry,
  EventEnvelope,
  ForgeJob,
  WorkflowDefinition,
} from "./contracts.js";
import { ScopedMemory, type MemoryRecord } from "./memory.js";

export const STATE_COLLECTIONS = [
  "events",
  "workflows",
  "actions",
  "runs",
  "forges",
  "audit",
  "memory",
] as const;
export type StateCollection = (typeof STATE_COLLECTIONS)[number];

/** One upserted record. `workspaceId` routes it to its durable partition. */
export type StateChange = {
  collection: StateCollection;
  id: string;
  workspaceId: string;
  body: unknown;
};

/** Persisted records per collection, oldest first (the order they were created). */
export type StateSnapshot = {
  events?: EventEnvelope[];
  workflows?: WorkflowDefinition[];
  actions?: ActionProposal[];
  runs?: AgentRun[];
  forges?: ForgeJob[];
  audit?: AuditEntry[];
  memory?: MemoryRecord[];
};

const FALLBACK_WORKSPACE = "demo-workspace";

export type DecisionResult<T> = {
  value?: T;
  error?: "not_found" | "conflict" | "expired";
  message?: string;
};

export class EventForgeStore {
  readonly memory = new ScopedMemory();
  #events: EventEnvelope[] = [];
  #workflows: WorkflowDefinition[] = [];
  #actions: ActionProposal[] = [];
  #runs: AgentRun[] = [];
  #forges: ForgeJob[] = [];
  #audit: AuditEntry[] = [];
  #dedupe = new Set<string>();
  #auditListeners = new Set<(entry: AuditEntry) => void | Promise<void>>();
  #changeListeners = new Set<(change: StateChange) => void>();

  constructor() {
    this.memory.subscribe((record) => this.#emit("memory", record.id, record.workspaceId, record));
  }

  /**
   * Notified synchronously after every mutation with a full copy of the record.
   * Listeners must not throw; they are expected to queue the change for persistence.
   */
  subscribeChanges(listener: (change: StateChange) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /** Load persisted state (oldest first per collection). Replaces current contents; no change events. */
  hydrate(snapshot: StateSnapshot): void {
    const newestFirst = <T>(items: T[] | undefined) => [...(items ?? [])].reverse();
    this.#events = newestFirst(snapshot.events);
    this.#dedupe = new Set(this.#events.map((event) => event.dedupeKey));
    this.#workflows = newestFirst(snapshot.workflows);
    this.#actions = newestFirst(snapshot.actions);
    this.#runs = newestFirst(snapshot.runs);
    this.#forges = newestFirst(snapshot.forges);
    this.#audit = newestFirst(snapshot.audit);
    this.memory.load(newestFirst(snapshot.memory));
  }

  #emit(collection: StateCollection, id: string, workspaceId: string, record: unknown): void {
    if (!this.#changeListeners.size) return;
    const body = structuredClone(record);
    for (const listener of this.#changeListeners) {
      try {
        listener({ collection, id, workspaceId, body });
      } catch {
        // A persistence listener must never break the request path.
      }
    }
  }

  #runWorkspace(run: AgentRun): string {
    return (
      this.workflowById(run.workflowId)?.workspaceId ??
      this.eventById(run.eventId)?.workspaceId ??
      FALLBACK_WORKSPACE
    );
  }

  #actionWorkspace(action: ActionProposal): string {
    return (
      this.workflowById(action.workflowId)?.workspaceId ??
      this.eventById(action.eventId)?.workspaceId ??
      FALLBACK_WORKSPACE
    );
  }

  appendEvent(event: EventEnvelope): { created: boolean; event: EventEnvelope } {
    if (this.#dedupe.has(event.dedupeKey))
      return {
        created: false,
        event: this.#events.find((item) => item.dedupeKey === event.dedupeKey) ?? event,
      };
    this.#dedupe.add(event.dedupeKey);
    this.#events.unshift(event);
    this.#emit("events", event.id, event.workspaceId, event);
    this.audit(
      event.workspaceId,
      "event_received",
      event.id,
      `${event.provider}:${event.topic} accepted (${event.signatureStatus}).`,
    );
    return { created: true, event };
  }

  events(workspaceId?: string): EventEnvelope[] {
    return workspaceId
      ? this.#events.filter((event) => event.workspaceId === workspaceId)
      : [...this.#events];
  }
  workflows(workspaceId?: string): WorkflowDefinition[] {
    return workspaceId
      ? this.#workflows.filter((workflow) => workflow.workspaceId === workspaceId)
      : [...this.#workflows];
  }
  /** Adds a workflow, or replaces the stored one with the same id in place. */
  addWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
    const index = this.#workflows.findIndex((item) => item.id === workflow.id);
    if (index >= 0) this.#workflows[index] = workflow;
    else this.#workflows.unshift(workflow);
    this.#emit("workflows", workflow.id, workflow.workspaceId, workflow);
    return workflow;
  }
  updateWorkflowPolicy(
    id: string,
    policy: WorkflowDefinition["policy"],
  ): WorkflowDefinition | undefined {
    const workflow = this.workflowById(id);
    if (!workflow) return undefined;
    workflow.policy = policy;
    this.#emit("workflows", workflow.id, workflow.workspaceId, workflow);
    return workflow;
  }
  actions(workspaceId?: string): ActionProposal[] {
    return workspaceId
      ? this.#actions.filter(
          (action) => this.workflowById(action.workflowId)?.workspaceId === workspaceId,
        )
      : [...this.#actions];
  }
  runs(): AgentRun[] {
    return [...this.#runs];
  }
  forgeJobs(workspaceId?: string): ForgeJob[] {
    return workspaceId
      ? this.#forges.filter((forge) => forge.workspaceId === workspaceId)
      : [...this.#forges];
  }
  auditEntries(workspaceId?: string): AuditEntry[] {
    return workspaceId
      ? this.#audit.filter((entry) => entry.workspaceId === workspaceId)
      : [...this.#audit];
  }
  workflowById(id: string): WorkflowDefinition | undefined {
    return this.#workflows.find((workflow) => workflow.id === id);
  }
  eventById(id: string): EventEnvelope | undefined {
    return this.#events.find((event) => event.id === id);
  }
  addAction(action: ActionProposal): ActionProposal {
    this.#actions.unshift(action);
    this.#emit("actions", action.id, this.#actionWorkspace(action), action);
    return action;
  }
  actionById(id: string): ActionProposal | undefined {
    return this.#actions.find((action) => action.id === id);
  }
  addRun(run: AgentRun): AgentRun {
    this.#runs.unshift(run);
    this.#emit("runs", run.id, this.#runWorkspace(run), run);
    return run;
  }
  updateRun(id: string, patch: Partial<AgentRun>): AgentRun | undefined {
    const item = this.#runs.find((run) => run.id === id);
    if (!item) return undefined;
    Object.assign(item, patch);
    this.#emit("runs", item.id, this.#runWorkspace(item), item);
    return item;
  }
  addForge(job: ForgeJob): ForgeJob {
    this.#forges.unshift(job);
    this.#emit("forges", job.id, job.workspaceId, job);
    return job;
  }
  forgeById(id: string): ForgeJob | undefined {
    return this.#forges.find((forge) => forge.id === id);
  }

  decideAction(
    id: string,
    input: {
      approved: boolean;
      reviewer: string;
      expectedVersion?: number;
      reason?: string;
      now?: Date;
    },
  ): DecisionResult<ActionProposal> {
    const action = this.actionById(id);
    if (!action) return { error: "not_found", message: "Action not found." };
    if (input.expectedVersion !== undefined && input.expectedVersion !== action.version) {
      return {
        value: action,
        error: "conflict",
        message: `Action version is ${action.version}, not ${input.expectedVersion}.`,
      };
    }
    if (action.status !== "pending")
      return { value: action, error: "conflict", message: `Action is already ${action.status}.` };
    const now = input.now ?? new Date();
    if (action.expiresAt && Date.parse(action.expiresAt) <= now.getTime()) {
      action.status = "expired";
      action.version += 1;
      this.#emit("actions", action.id, this.#actionWorkspace(action), action);
      return { value: action, error: "expired", message: "Action approval has expired." };
    }
    action.status = input.approved ? "approved" : "rejected";
    action.reviewer = input.reviewer;
    action.decisionReason = input.reason;
    action.decidedAt = now.toISOString();
    action.version += 1;
    this.#emit("actions", action.id, this.#actionWorkspace(action), action);
    const workflow = this.workflowById(action.workflowId);
    if (workflow)
      this.audit(
        workflow.workspaceId,
        "approval",
        action.id,
        `${input.reviewer} ${input.approved ? "approved" : "rejected"} ${action.title}.`,
      );
    return { value: action };
  }

  decideForge(id: string, approved: boolean, reviewer: string): ForgeJob | undefined {
    const job = this.forgeById(id);
    if (!job || job.status !== "validated") return job;
    job.status = approved ? "approved" : "rejected";
    job.approvedBy = reviewer;
    this.#emit("forges", job.id, job.workspaceId, job);
    this.audit(
      job.workspaceId,
      "forge",
      job.id,
      `${reviewer} ${approved ? "approved" : "rejected"} forge artifact.`,
    );
    return job;
  }

  audit(
    workspaceId: string,
    kind: AuditEntry["kind"],
    subjectId: string,
    message: string,
  ): AuditEntry {
    const entry = {
      id: randomUUID(),
      workspaceId,
      kind,
      subjectId,
      message,
      createdAt: new Date().toISOString(),
    };
    this.#audit.unshift(entry);
    this.#emit("audit", entry.id, entry.workspaceId, entry);
    for (const listener of this.#auditListeners) void listener(entry);
    return entry;
  }

  subscribeAudit(listener: (entry: AuditEntry) => void | Promise<void>): () => void {
    this.#auditListeners.add(listener);
    return () => this.#auditListeners.delete(listener);
  }
}
