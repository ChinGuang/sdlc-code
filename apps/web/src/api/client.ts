/**
 * The dashboard's calls to the local server. Every request goes to /api, which
 * Vite forwards to the server in development, and the server's own message is
 * what a person sees when a request is refused: it says what to do.
 */
import type {
  DesignVerdict,
  DocumentKind,
  DocumentView,
  EscalationResolution,
  PullRequestDecision,
  RunDetail,
  RunEvent,
  RunSummary,
  StartRunRequest,
} from "./types.js";

export class ApiError extends Error {
  readonly status: number;
  /** For a 400: every problem with the request, one per field. */
  readonly problems: string[];

  constructor(status: number, message: string, problems: string[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.problems = problems;
  }
}

/** What the screens need from the server; tests pass their own. */
export interface RunsApi {
  listRuns: () => Promise<RunSummary[]>;
  getRun: (runId: string) => Promise<RunDetail>;
  startRun: (request: StartRunRequest) => Promise<RunSummary>;
  /** A document in full; the Run's detail only lists them. */
  getDocument: (runId: string, kind: DocumentKind) => Promise<DocumentView>;
  /** Designs a gated Run again after its design failed. */
  retryDesign: (runId: string) => Promise<RunDetail>;
  /** Stops the Run, whatever it is doing; a Draft PR of what passed if asked. */
  abortRun: (runId: string, openDraftPrOnAbort: boolean) => Promise<RunDetail>;
  /** Each answers with the Run as the decision left it. */
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
  /** Whether the local server answers at all. */
  serverUp: () => Promise<boolean>;
  /** Follows a Run's events from `after`; returns what stops following. */
  followRun: (
    runId: string,
    after: number,
    onEvent: (event: RunEvent) => void,
  ) => () => void;
}

export type HttpRunsApiOptions = {
  base?: string;
  fetch?: typeof fetch;
  /** A browser's EventSource; tests pass a fake. */
  eventSource?: (url: string) => EventSource;
};

export class HttpRunsApi implements RunsApi {
  #base: string;
  #fetch: typeof fetch;
  #eventSource: (url: string) => EventSource;

  constructor(options: HttpRunsApiOptions = {}) {
    this.#base = options.base ?? "/api";
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
    this.#eventSource = options.eventSource ?? ((url) => new EventSource(url));
  }

  listRuns = (): Promise<RunSummary[]> => this.#call("GET", "/runs");

  getRun = (runId: string): Promise<RunDetail> =>
    this.#call("GET", `/runs/${encodeURIComponent(runId)}`);

  startRun = (request: StartRunRequest): Promise<RunSummary> =>
    this.#call("POST", "/runs", request);

  getDocument = (runId: string, kind: DocumentKind): Promise<DocumentView> =>
    this.#call("GET", `${runPath(runId)}/documents/${kind}`);

  abortRun = (runId: string, openDraftPrOnAbort: boolean): Promise<RunDetail> =>
    this.#call("POST", `${runPath(runId)}/abort`, { openDraftPrOnAbort });

  retryDesign = (runId: string): Promise<RunDetail> =>
    this.#call("POST", `${runPath(runId)}/retry-design`, {});

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

  serverUp = (): Promise<boolean> =>
    this.#fetch(`${this.#base}/health`).then(
      (response) => response.ok,
      () => false,
    );

  followRun = (
    runId: string,
    after: number,
    onEvent: (event: RunEvent) => void,
  ): (() => void) => {
    // `after` only on the first connection: when EventSource reconnects on its
    // own it sends Last-Event-ID, which the server reads instead.
    const source = this.#eventSource(
      `${this.#base}/runs/${encodeURIComponent(runId)}/events?after=${after}`,
    );
    const receive = (message: MessageEvent<string>) => {
      let event: RunEvent;
      try {
        event = JSON.parse(message.data) as RunEvent;
      } catch {
        return; // Not an event this dashboard can read; the next one may be.
      }
      onEvent(event);
    };
    for (const type of EVENT_TYPES) source.addEventListener(type, receive);
    return () => source.close();
  };

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const { message, problems } = (parsed ?? {}) as {
        message?: string;
        problems?: string[];
      };
      throw new ApiError(
        response.status,
        message ?? `The server answered ${response.status}.`,
        problems ?? [],
      );
    }
    return parsed as T;
  }
}

/**
 * The server names each SSE message by its event type, so a listener per type
 * is what receives them; one "message" listener would receive none.
 */
const EVENT_TYPES = [
  "status",
  "step",
  "tokens",
  "agentTurn",
  "toolFailed",
  "checkpoint",
  "testRun",
  "exportFailed",
  "reviewProblem",
  "delivery",
  "problem",
] as const;

const runPath = (runId: string) => `/runs/${encodeURIComponent(runId)}`;
