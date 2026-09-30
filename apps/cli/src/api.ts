/**
 * The CLI's calls to the local server (apps/server). Like the dashboard, it is
 * a client of the HTTP API and writes out the shapes it reads rather than
 * importing the server's code; the server's own tests pin the other side.
 */
import { createSseParser } from "./sse.js";

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

export type DocumentKind =
  "systemDesign" | "slicePlan" | "apiContract" | "uiSpec" | "penpotDesign";

export type AgentRole =
  | "orchestrator"
  | "systemDesign"
  | "uiDesign"
  | "backendCoding"
  | "frontendCoding"
  | "testing"
  | "codeReview";

export type PullRequest = { number: number; url: string; draft: boolean };

export type RunSummary = {
  id: string;
  projectRequest: string;
  mode: "gated" | "auto";
  status: RunStatus;
  tokensUsed: number;
  tokenBudget: number;
  pullRequest: PullRequest | null;
  createdAt: string;
  updatedAt: string;
};

export type IssueSummary = {
  step: string;
  failingTest: string | null;
  file: string | null;
  endpoint: string | null;
  error: string;
  suspectedOwner: AgentRole | null;
  occurrences: number;
};

export type Waiting =
  | { for: "nothing" }
  | {
      for: "designGate";
      documents: Array<{ kind: DocumentKind; version: number }>;
    }
  | {
      for: "escalation";
      id: string;
      trigger: string;
      summary: string;
      slice: string | null;
      reports: IssueSummary[];
      workingMemory: Array<{ role: AgentRole; note: string }>;
      openDraftPrOnAbort: boolean;
    }
  | { for: "prGate"; pullRequest: PullRequest | null };

export type Finding = {
  ruleId: string;
  severity: "blocking" | "major" | "minor";
  source: "linter" | "codeReview";
  file: string;
  line: number;
  message: string;
  suggestion: string | null;
};

export type RunDetail = RunSummary & {
  slices: Array<{
    id: string;
    title: string;
    status: "pending" | "building" | "testing" | "passed" | "skipped";
    isWalkingSkeleton: boolean;
    commitSha: string | null;
  }>;
  documents: Array<{
    kind: DocumentKind;
    version: number;
    status: string;
    ownerAgent: AgentRole;
    wouldMakeStale: DocumentKind[];
  }>;
  reviews: Array<{
    findings: Finding[];
    stopReason: string;
    problems: string[];
    createdAt: string;
  }>;
  tasks: Array<{
    id: string;
    sliceId: string | null;
    role: AgentRole;
    status: "pending" | "running" | "done" | "failed";
    retriesSpent: number;
    steps: Array<{ id: string; status: string }>;
  }>;
  waiting: Waiting;
  failure: { trigger: string; summary: string; slice: string | null } | null;
  advancing: boolean;
  lastSeq: number;
};

export type DocumentView = {
  kind: DocumentKind;
  version: number;
  status: string;
  ownerAgent: AgentRole;
  content: string;
};

/** An event as the stream sends it; the CLI reads only what it prints. */
export type RunEvent = {
  runId: string;
  seq: number;
  happenedAt: string;
  type: string;
  [field: string]: unknown;
};

export type StartRunRequest = {
  projectRequest: string;
  mode: "gated" | "auto";
  tokenBudget: number;
  targetRepo?: string | null;
};

export type DesignVerdict = {
  documentKind: DocumentKind;
  decision: "approve" | "requestChanges";
  comments: string;
};

type GoingOn = { tokenBudget?: number };

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

/** The server refused, or could not be reached; its message says what to do. */
export class ApiError extends Error {
  readonly status: number;
  readonly problems: string[];

  constructor(status: number, message: string, problems: string[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.problems = problems;
  }
}

/** What the commands need from the server; tests pass their own. */
export interface ServerApi {
  listRuns: () => Promise<RunSummary[]>;
  getRun: (runId: string) => Promise<RunDetail>;
  getDocument: (runId: string, kind: DocumentKind) => Promise<DocumentView>;
  startRun: (request: StartRunRequest) => Promise<RunSummary>;
  decideDesign: (
    runId: string,
    verdicts: DesignVerdict[],
  ) => Promise<RunDetail>;
  resolveEscalation: (
    runId: string,
    resolution: EscalationResolution,
  ) => Promise<RunDetail>;
  decidePullRequest: (
    runId: string,
    decision: PullRequestDecision,
  ) => Promise<RunDetail>;
  abortRun: (runId: string, openDraftPrOnAbort: boolean) => Promise<RunDetail>;
  /**
   * Calls `onEvent` for each of the Run's events after `after`, until
   * `onEvent` returns "stop" or the stream ends.
   */
  follow: (
    runId: string,
    after: number,
    onEvent: (event: RunEvent) => "stop" | void,
  ) => Promise<void>;
}

export type HttpServerApiOptions = {
  /** e.g. http://127.0.0.1:4317 */
  baseUrl: string;
  fetch?: typeof fetch;
};

export class HttpServerApi implements ServerApi {
  #base: string;
  #fetch: typeof fetch;

  constructor(options: HttpServerApiOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
  }

  listRuns = (): Promise<RunSummary[]> => this.#call("GET", "/runs");

  getRun = (runId: string): Promise<RunDetail> =>
    this.#call("GET", runPath(runId));

  getDocument = (runId: string, kind: DocumentKind): Promise<DocumentView> =>
    this.#call("GET", `${runPath(runId)}/documents/${kind}`);

  startRun = (request: StartRunRequest): Promise<RunSummary> =>
    this.#call("POST", "/runs", request);

  decideDesign = (
    runId: string,
    verdicts: DesignVerdict[],
  ): Promise<RunDetail> =>
    this.#call("POST", `${runPath(runId)}/design-gate`, { verdicts });

  resolveEscalation = (
    runId: string,
    resolution: EscalationResolution,
  ): Promise<RunDetail> =>
    this.#call("POST", `${runPath(runId)}/escalation`, resolution);

  decidePullRequest = (
    runId: string,
    decision: PullRequestDecision,
  ): Promise<RunDetail> =>
    this.#call("POST", `${runPath(runId)}/pr-gate`, decision);

  abortRun = (runId: string, openDraftPrOnAbort: boolean): Promise<RunDetail> =>
    this.#call("POST", `${runPath(runId)}/abort`, { openDraftPrOnAbort });

  follow = async (
    runId: string,
    after: number,
    onEvent: (event: RunEvent) => "stop" | void,
  ): Promise<void> => {
    const stop = new AbortController();
    const response = await this.#send(
      `${runPath(runId)}/events?after=${after}`,
      { headers: { accept: "text/event-stream" }, signal: stop.signal },
    );
    if (!response.ok) throw await refusal(response);
    if (!response.body) return;
    let stopped = false;
    const parser = createSseParser((message) => {
      if (stopped) return;
      let event: RunEvent;
      try {
        event = JSON.parse(message.data) as RunEvent;
      } catch {
        return; // Not an event this client can read; the next one may be.
      }
      if (onEvent(event) === "stop") stopped = true;
    });
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        parser(decoder.decode(value, { stream: true }));
      }
    } finally {
      stop.abort();
    }
  };

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#send(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw await refusal(response);
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** A request, or the one error that says the server is not there. */
  async #send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(`${this.#base}${path}`, init);
    } catch {
      throw new ApiError(
        0,
        `No sdlc-code server at ${this.#base}. Start it with: pnpm --filter @sdlc-code/server dev`,
      );
    }
  }
}

async function refusal(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => "");
  let body: { message?: unknown; problems?: unknown } = {};
  try {
    body = text ? (JSON.parse(text) as typeof body) : {};
  } catch {
    // Not JSON: the status says enough.
  }
  return new ApiError(
    response.status,
    typeof body.message === "string"
      ? body.message
      : `The server answered ${response.status}.`,
    Array.isArray(body.problems) ? body.problems.map(String) : [],
  );
}

const runPath = (runId: string) => `/runs/${encodeURIComponent(runId)}`;
