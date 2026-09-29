/**
 * What the HTTP API can do with Runs (T21). Controllers depend on this, never
 * on the runtime, so every route can be tested without a model, a sandbox or a
 * browser tab.
 */
import type {
  DesignVerdict,
  DocumentKind,
  EscalationResolution,
  PullRequestDecision,
  RunMode,
  RunStatus,
  RuntimeEvent,
} from "@sdlc-code/core";
import type { Observable } from "rxjs";

export type StartRunRequest = {
  projectRequest: string;
  mode: RunMode;
  tokenBudget: number;
  /** "owner/name"; without one the Run keeps its Slice Commits local. */
  targetRepo?: string | null;
};

/** A Run as a list shows it. */
export type RunSummary = {
  id: string;
  projectRequest: string;
  mode: RunMode;
  status: RunStatus;
  tokensUsed: number;
  tokenBudget: number;
  pullRequest: { number: number; url: string; draft: boolean } | null;
  createdAt: string;
  updatedAt: string;
};

/** What a person is being asked, if anything. */
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
      /** The abort dialog's checkbox, ticked unless a person unticks it. */
      openDraftPrOnAbort: boolean;
    }
  | { for: "prGate"; pullRequest: RunSummary["pullRequest"] };

/** A Run as its own page shows it. */
export type RunDetail = RunSummary & {
  slices: Array<{
    title: string;
    status: string;
    isWalkingSkeleton: boolean;
    commitSha: string | null;
  }>;
  documents: Array<{ kind: DocumentKind; version: number; status: string }>;
  waiting: Waiting;
  failure: { trigger: string; summary: string; slice: string | null } | null;
  /** True while the server is advancing this Run in the background. */
  advancing: boolean;
};

/**
 * An event as the stream sends it: numbered, so a client sees the order, and
 * stamped with when it happened. (Not "at": a checkpoint event has one.)
 */
export type StreamedEvent = RuntimeEvent & { seq: number; happenedAt: string };

export interface RunService {
  startRun: (request: StartRunRequest) => Promise<RunSummary>;
  listRuns: () => RunSummary[];
  getRun: (runId: string) => RunDetail;
  decideDesign: (runId: string, verdicts: DesignVerdict[]) => RunDetail;
  resolveEscalation: (
    runId: string,
    resolution: EscalationResolution,
  ) => RunDetail;
  decidePullRequest: (
    runId: string,
    decision: PullRequestDecision,
  ) => RunDetail;
  /**
   * The Run's events from now on. With `after`, the ones this server has kept
   * since then come first, so a client that reconnects misses nothing it could
   * still be told.
   */
  events: (runId: string, after?: number) => Observable<StreamedEvent>;
}

/** Nest injection token for RunService (interfaces vanish at runtime). */
export const RUN_SERVICE = Symbol("RunService");

/** No Run with that id. */
export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`No Run ${runId}.`);
    this.name = "RunNotFoundError";
  }
}

/** The Run exists, but is not where this request needs it to be. */
export class RunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunConflictError";
  }
}

/** The server cannot run anything yet, e.g. a key is missing. */
export class RuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}
