/**
 * The shapes the local server answers with (apps/server/src/runs/runService.ts).
 * Written out here rather than imported, because the dashboard is a client of
 * an HTTP API and must not depend on the server's code; the server's own tests
 * pin the other side of this contract.
 */

export type RunMode = "gated" | "auto";

export type RunStatus =
  | "designing"
  | "awaitingDesignGate"
  | "building"
  | "reviewing"
  | "awaitingPrGate"
  | "escalated"
  | "done"
  | "failed"
  | "aborted";

export type SliceStatus =
  "pending" | "building" | "testing" | "passed" | "skipped";

export type AgentRole =
  | "orchestrator"
  | "systemDesign"
  | "uiDesign"
  | "backendCoding"
  | "frontendCoding"
  | "testing"
  | "codeReview";

export type DocumentKind =
  "systemDesign" | "slicePlan" | "apiContract" | "uiSpec" | "penpotDesign";

export type DocumentStatus =
  "drafting" | "inReview" | "approved" | "changesRequested" | "stale";

export type PullRequest = { number: number; url: string; draft: boolean };

export type RunSummary = {
  id: string;
  projectRequest: string;
  mode: RunMode;
  status: RunStatus;
  tokensUsed: number;
  tokenBudget: number;
  pullRequest: PullRequest | null;
  createdAt: string;
  updatedAt: string;
};

export type Waiting =
  | { for: "nothing" }
  | {
      for: "designGate";
      documents: Array<{ kind: DocumentKind; version: number }>;
    }
  | {
      for: "escalation";
      /** Which Escalation: a later one is a new question, even if it reads the same. */
      id: string;
      trigger: string;
      summary: string;
      /** The Slice it stopped in, by title; null outside the build. */
      slice: string | null;
      /** What kept failing. */
      reports: IssueSummary[];
      /** Each Coding Agent's last note on that Slice: what it tried. */
      workingMemory: Array<{ role: AgentRole; note: string }>;
      openDraftPrOnAbort: boolean;
    }
  | { for: "prGate"; pullRequest: PullRequest | null };

/** An Issue Report (T16) as a person reads it; the evidence stays with the agents. */
export type IssueSummary = {
  step: string;
  failingTest: string | null;
  file: string | null;
  endpoint: string | null;
  error: string;
  suspectedOwner: AgentRole | null;
  occurrences: number;
};

export type RunDocument = {
  kind: DocumentKind;
  version: number;
  status: DocumentStatus;
  ownerAgent: AgentRole;
  /** What a change to it would make Stale now: the Design Gate's warning. */
  wouldMakeStale: DocumentKind[];
};

/** A document in full, read one at a time. */
export type DocumentView = {
  kind: DocumentKind;
  version: number;
  status: DocumentStatus;
  ownerAgent: AgentRole;
  content: string;
};

export type Severity = "blocking" | "major" | "minor";

export type Finding = {
  ruleId: string;
  severity: Severity;
  source: "linter" | "codeReview";
  file: string;
  /** 0 when it is about the file as a whole. */
  line: number;
  message: string;
  suggestion: string | null;
};

export type Review = {
  findings: Finding[];
  /** "answered" unless the agent ran out of turns or Token Budget. */
  stopReason: string;
  problems: string[];
  createdAt: string;
};

export type RunSlice = {
  id: string;
  title: string;
  status: SliceStatus;
  isWalkingSkeleton: boolean;
  commitSha: string | null;
};

export type RunTask = {
  id: string;
  sliceId: string | null;
  role: AgentRole;
  status: "pending" | "running" | "done" | "failed";
  /** Spent of its Retry Budget: counted since the last hint refilled it. */
  retriesSpent: number;
  steps: Array<{
    id: string;
    status: "running" | "completed" | "discarded";
    startedAt: string;
    endedAt: string | null;
  }>;
};

export type RunDetail = RunSummary & {
  slices: RunSlice[];
  documents: RunDocument[];
  /** Every review of the Run's diff, oldest first. */
  reviews: Review[];
  /** The screens as drawn, for the latest UI design; none for an old Run. */
  screenshots: Array<{ screen: string; version: number; order: number }>;
  tasks: RunTask[];
  waiting: Waiting;
  failure: { trigger: string; summary: string; slice: string | null } | null;
  advancing: boolean;
  lastSeq: number;
};

/** What the event stream carries; `seq` orders them. */
export type RunEvent = { runId: string; seq: number; happenedAt: string } & (
  | { type: "status"; status: RunStatus }
  | {
      type: "step";
      phase: "started" | "completed" | "discarded";
      stepId: string;
      taskId: string;
      role: AgentRole;
      sliceId: string | null;
    }
  | { type: "tokens"; used: number; budget: number }
  | { type: "agentTurn"; role: AgentRole; toolCalls: string[] }
  | { type: "toolFailed"; role: AgentRole; tool: string; problem: string }
  | {
      type: "checkpoint";
      at: "merged" | "committed" | "retrying";
      sliceId: string;
    }
  | {
      type: "testRun";
      status: "passed" | "failed" | "broken";
      summary: string;
      durationSeconds: number | null;
      cost: number | null;
      issues: string[];
    }
  | { type: "exportFailed"; screen: string; reason: string }
  | { type: "reviewProblem"; problem: string }
  | { type: "delivery"; status: "opened" | "keptLocal"; detail: string }
  | { type: "problem"; problem: string }
);

export type RunEventType = RunEvent["type"];

export type StartRunRequest = {
  projectRequest: string;
  mode: RunMode;
  tokenBudget: number;
  targetRepo?: string | null;
};

/** A person's Verdict on one document at the Design Gate. */
export type DesignVerdict = {
  documentKind: DocumentKind;
  decision: "approve" | "requestChanges";
  comments: string;
};

/** Every way on but abort spends tokens: a spent budget must be raised. */
type GoingOn = { tokenBudget?: number };

/** The four ways out of an Escalation (CONTEXT.md). */
export type EscalationResolution =
  | ({ choice: "retryWithHint"; hint: string } & GoingOn)
  | ({
      choice: "editDocuments";
      edits: Array<{ documentKind: DocumentKind; comments: string }>;
    } & GoingOn)
  | ({ choice: "skipSlice" } & GoingOn)
  | { choice: "abort"; openDraftPrOnAbort: boolean };

export type PullRequestDecision =
  { choice: "approve" } | { choice: "requestChanges"; comments: string };
