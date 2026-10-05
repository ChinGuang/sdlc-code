// SPDX-License-Identifier: MPL-2.0
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

/**
 * Why a Run failed with no one to ask (auto mode): its Draft PR says so (T20).
 * Also why a gated Run's design failed, while it waits for a person to ask
 * for another try (T24f).
 */
export type RunFailure = {
  /** An Escalation trigger, or "design" when no valid design came out. */
  trigger: EscalationTrigger | "design";
  summary: string;
  /** The Slice being built; null when the Run failed while designing. */
  slice: string | null;
  /** The Issue Reports behind it (T16), as stored. */
  reports: unknown[];
};

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
  failure: RunFailure | null;
  /**
   * Whether a person who aborted it outside an Escalation asked for a Draft
   * PR of what passed; null when no one did (T24g).
   */
  openDraftPrOnAbort: boolean | null;
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

/** A Gate is open until it is decided: passed, or sent back with comments. */
export type GateStatus = "open" | "passed" | "changesRequested";

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
  /** The Slice being built when it stopped; null when it was not building. */
  slice: string | null;
  /** The Issue Reports behind it (T16), as stored. */
  reports: unknown[];
  /** What went wrong in plain words (T24c); null until it is written. */
  brief: EscalationBrief | null;
  createdAt: string;
  resolvedAt: string | null;
};

/**
 * What a person reads before deciding at an Escalation (T24c): facts found
 * in code, and the Orchestrator's one read-only look at the failure.
 */
export type EscalationBrief = {
  /** Found without a model, so always there, even with no budget left. */
  facts: string[];
  analysis: BriefAnalysis | null;
  /** Why there is no analysis, when there is none. */
  withoutAnalysis: string | null;
};

export type BriefAnalysis = {
  /** What is failing, in a sentence or two. */
  failing: string;
  /** What the agents tried, from their Working Memory. */
  tried: string;
  /** The likely cause, naming the file and what is wrong there. */
  cause: string;
  /** The choice it suggests to the person. */
  choice: EscalationChoice;
  /** A hint ready to send with "retry with hint"; null for other choices. */
  hint: string | null;
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
