/**
 * What the HTTP API can do with Runs (T21). Controllers depend on this, never
 * on the runtime, so every route can be tested without a model, a sandbox or a
 * browser tab.
 */
import type {
  AgentRole,
  DesignVerdict,
  DocumentKind,
  DocumentStatus,
  EscalationResolution,
  PullRequestDecision,
  RunMode,
  RunStatus,
  Finding,
  RuntimeEvent,
  SliceStatus,
  StepStatus,
  TaskStatus,
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

/**
 * An Issue Report (T16) as a person reads it: what failed, where, and whose
 * the Testing Agent suspects it is. The evidence stays with the agents.
 */
export type IssueSummary = {
  step: string;
  failingTest: string | null;
  file: string | null;
  endpoint: string | null;
  error: string;
  suspectedOwner: AgentRole | null;
  /** How many failures shared it in one Test Run. */
  occurrences: number;
};

/** What an agent wrote at the end of its last Step (CONTEXT.md "Working Memory"). */
export type WorkingMemoryNote = { role: AgentRole; note: string };

/** A Finding (T19): a Rule broken, with the Rule's severity. */
export type FindingView = {
  ruleId: string;
  severity: Finding["severity"];
  source: "linter" | "codeReview";
  file: string;
  /** 0 when it is about the file as a whole. */
  line: number;
  message: string;
  suggestion: string | null;
};

/** One review of the Run's diff; a blocking Finding makes another. */
export type ReviewView = {
  findings: FindingView[];
  /** "answered" unless the agent ran out of turns or Token Budget. */
  stopReason: string;
  problems: string[];
  createdAt: string;
};

/** A design document in full, for the person judging it at the Design Gate. */
export type DocumentView = {
  kind: DocumentKind;
  version: number;
  status: DocumentStatus;
  ownerAgent: AgentRole;
  content: string;
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
      /** Which Escalation: a later one is a new question, even if it reads the same. */
      id: string;
      trigger: string;
      summary: string;
      /** The Slice it stopped in, by title; null outside the build. */
      slice: string | null;
      /** What kept failing. */
      reports: IssueSummary[];
      /** Each Coding Agent's last note on that Slice: what it tried. */
      workingMemory: WorkingMemoryNote[];
      /** The abort dialog's checkbox, ticked unless a person unticks it. */
      openDraftPrOnAbort: boolean;
    }
  | { for: "prGate"; pullRequest: RunSummary["pullRequest"] };

/** A Run as its own page shows it. */
export type RunDetail = RunSummary & {
  /** In Slice Plan order; `id` is what checkpoint and Step events name. */
  slices: Array<{
    id: string;
    title: string;
    status: SliceStatus;
    isWalkingSkeleton: boolean;
    commitSha: string | null;
  }>;
  documents: Array<{
    kind: DocumentKind;
    version: number;
    status: DocumentStatus;
    ownerAgent: AgentRole;
    /** What a change to it would make Stale now: the Design Gate's warning. */
    wouldMakeStale: DocumentKind[];
  }>;
  /** Every review of the Run's diff, oldest first. */
  reviews: ReviewView[];
  /**
   * The screens as drawn, for the latest UI design; each is served at
   * /runs/:id/screenshots/:version/:order. None for a Run from before T24e.
   */
  screenshots: Array<{ screen: string; version: number; order: number }>;
  /**
   * Each agent's Task and its Steps: a Slice's backend and frontend lanes, and
   * how much of its Retry Budget each has spent.
   */
  tasks: Array<{
    id: string;
    /** Null for a design Task, which belongs to no Slice. */
    sliceId: string | null;
    role: AgentRole;
    status: TaskStatus;
    /** Spent of its Retry Budget: counted since the last hint refilled it. */
    retriesSpent: number;
    steps: Array<{
      id: string;
      status: StepStatus;
      startedAt: string;
      endedAt: string | null;
    }>;
  }>;
  waiting: Waiting;
  failure: { trigger: string; summary: string; slice: string | null } | null;
  /** True while the server is advancing this Run in the background. */
  advancing: boolean;
  /**
   * The number of this Run's last event, so a client that reads the Run and
   * then follows it with ?after=lastSeq misses nothing in between.
   */
  lastSeq: number;
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
  /** A document's latest version in full; the Run's detail lists it only. */
  getDocument: (runId: string, kind: DocumentKind) => DocumentView;
  /** One screen as drawn, as an image. */
  getScreenshot: (
    runId: string,
    version: number,
    order: number,
  ) => { bytes: Buffer; mimeType: string };
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
   * Aborts a Run at its Escalation, the only place the domain lets a Run be
   * aborted (CONTEXT.md). A Draft PR of what passed unless a person unticks it.
   */
  abortRun: (runId: string, openDraftPrOnAbort: boolean) => RunDetail;
  /**
   * The Run's events from now on. With `after`, the ones this server has kept
   * since then come first, so a client that reconnects misses nothing it could
   * still be told.
   */
  events: (runId: string, after?: number) => Observable<StreamedEvent>;
}

/** Nest injection token for RunService (interfaces vanish at runtime). */
export const RUN_SERVICE = Symbol("RunService");

/**
 * What the server does with Runs as it starts and stops, apart from requests:
 * pick up the unfinished ones (diagram 9), and close what it opened.
 */
export interface RunLifecycle {
  /** Resumes each unfinished Run; one that cannot be does not stop the rest. */
  resumeUnfinished: () => Promise<{
    resumed: string[];
    failed: Array<{ runId: string; problem: string }>;
  }>;
  shutdown: () => Promise<void>;
}

/** Nest injection token for RunLifecycle. */
export const RUN_LIFECYCLE = Symbol("RunLifecycle");

/** No Run with that id. */
export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`No Run ${runId}.`);
    this.name = "RunNotFoundError";
  }
}

/** The Run has no such document (yet). */
export class DocumentNotFoundError extends Error {
  constructor(runId: string, kind: string) {
    super(`Run ${runId} has no ${kind} document.`);
    this.name = "DocumentNotFoundError";
  }
}

/** The Run has no such screenshot. */
export class ScreenshotNotFoundError extends Error {
  constructor(runId: string, version: number, order: number) {
    super(
      `Run ${runId} has no screenshot ${order} of design version ${version}.`,
    );
    this.name = "ScreenshotNotFoundError";
  }
}

/** The Run exists, but is not where this request needs it to be. */
export class RunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunConflictError";
  }
}

/** The server cannot do this yet, e.g. a key it needs is not set. */
export class RuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}
