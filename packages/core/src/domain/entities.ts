/**
 * Domain entities from UML diagram 2 that the Orchestrator persists. The rest
 * arrive with the tasks that define them, as new migrations: Stack Profile (T12),
 * Test Run (T13), Workspace (T14), Issue Report (T16), Rule, Review Standard and
 * Finding (T19). Agent Config and Model Capabilities live in the config file (T05).
 */
import type { AgentRole } from "../agentRoles.js";
import type { DocumentKind, DocumentStatus } from "./documentLifecycle.js";
import type {
  EscalationChoice,
  EscalationTrigger,
  RunMode,
  RunStatus,
} from "./runLifecycle.js";

export type TargetRepo = {
  owner: string;
  name: string;
  baseBranch: string;
  /** The feature branch that collects Slice Commits and becomes the PR. */
  runBranch: string;
};

export type RunPullRequest = { number: number; url: string; draft: boolean };

export type Run = {
  id: string;
  projectRequest: string;
  mode: RunMode;
  status: RunStatus;
  targetRepo: TargetRepo;
  stackProfile: string;
  tokenBudget: number;
  tokensUsed: number;
  pullRequest: RunPullRequest | null;
  createdAt: string;
  updatedAt: string;
};

export type NewRun = Pick<
  Run,
  "projectRequest" | "mode" | "targetRepo" | "stackProfile" | "tokenBudget"
>;

/** One version of a document; a revision is a new version, older ones are kept. */
export type RunDocument = {
  id: string;
  runId: string;
  kind: DocumentKind;
  version: number;
  status: DocumentStatus;
  ownerAgent: AgentRole;
  content: string;
  createdAt: string;
};

export type GateKind = "design" | "pr";

export type GateStatus = "open" | "passed";

export type Gate = {
  id: string;
  runId: string;
  kind: GateKind;
  status: GateStatus;
  openedAt: string;
};

export type Verdict = {
  id: string;
  gateId: string;
  /** The document version judged; null for a PR Gate verdict on the whole PR. */
  document: { id: string; kind: DocumentKind; version: number } | null;
  decision: "approve" | "requestChanges";
  comments: string;
  createdAt: string;
};

export const SLICE_STATUSES = [
  "pending",
  "building",
  "testing",
  "passed",
  "skipped",
] as const;
export type SliceStatus = (typeof SLICE_STATUSES)[number];

export type Slice = {
  id: string;
  runId: string;
  order: number;
  title: string;
  isWalkingSkeleton: boolean;
  status: SliceStatus;
  /** The Slice Commit, once the Slice passed testing. */
  commitSha: string | null;
};

export type TaskStatus = "pending" | "running" | "done" | "failed";

export type Task = {
  id: string;
  runId: string;
  /** Null for design Tasks, which belong to no Slice. */
  sliceId: string | null;
  agentRole: AgentRole;
  status: TaskStatus;
  retries: number;
};

export type StepStatus = "running" | "completed" | "discarded";

export type Step = {
  id: string;
  taskId: string;
  status: StepStatus;
  /** The note the agent wrote at the end of the Step (CONTEXT.md "Working Memory"). */
  workingMemory: string | null;
  startedAt: string;
  endedAt: string | null;
};

/** One row of a Step's Transcript: a message, tool call, tool result or usage. */
export type StepEvent = {
  stepId: string;
  seq: number;
  type: string;
  payload: unknown;
  at: string;
};

export type Escalation = {
  id: string;
  runId: string;
  trigger: EscalationTrigger;
  summary: string;
  choice: EscalationChoice | null;
  hint: string | null;
  openDraftPrOnAbort: boolean;
  createdAt: string;
  resolvedAt: string | null;
};

/**
 * Everything needed to continue a Run after a restart (UML diagram 9). The
 * payload's shape (last Slice Commit, Working Memory, …) is defined by T18.
 */
export type Checkpoint = {
  id: string;
  runId: string;
  payload: unknown;
  createdAt: string;
};
