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
      trigger: string;
      summary: string;
      openDraftPrOnAbort: boolean;
    }
  | { for: "prGate"; pullRequest: PullRequest | null };

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
  retries: number;
  steps: Array<{
    id: string;
    status: "running" | "completed" | "discarded";
    startedAt: string;
    endedAt: string | null;
  }>;
};

export type RunDetail = RunSummary & {
  slices: RunSlice[];
  documents: Array<{
    kind: DocumentKind;
    version: number;
    status: DocumentStatus;
  }>;
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
