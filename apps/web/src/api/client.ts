// SPDX-License-Identifier: MPL-2.0
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

/** Whether the server asks for an access token, and whether this browser has given it. */
export type Session = { required: boolean; signedIn: boolean };

/** What the screens need from the server; tests pass their own. */
export interface RunsApi {
  /** A local server asks for nothing; one on a network asks for its token (S2). */
  session: () => Promise<Session>;
  /** Gives the server its access token; it answers with a cookie, not a copy. */
  signIn: (token: string) => Promise<void>;
  listRuns: () => Promise<RunSummary[]>;
  getRun: (runId: string) => Promise<RunDetail>;
  startRun: (request: StartRunRequest) => Promise<RunSummary>;
  /** Where a screen as drawn is, for an <img>: the server serves the image. */
  screenshotUrl: (runId: string, version: number, order: number) => string;
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
  /**
   * Follows a Run's events from `after`; returns what stops following. The
   * stream is kept: when it is lost and comes back (the server restarted),
   * `onReconnect` is called, so the caller reads what it missed.
   */
  followRun: (
    runId: string,
    after: number,
    onEvent: (event: RunEvent) => void,
    onReconnect?: () => void,
  ) => () => void;
}

export type HttpRunsApiOptions = {
  base?: string;
  fetch?: typeof fetch;
  /** A browser's EventSource; tests pass a fake. */
  eventSource?: (url: string) => EventSource;
  /** How long to wait before opening a stream the browser gave up on. */
  reconnectDelayMs?: number;
  /** Called when the server turns a request away for want of a sign-in (S2). */
  onUnauthorized?: () => void;
  /** How long a stream may say nothing, pings included, before it is dead. */
  staleAfterMs?: number;
};

/** EventSource.CLOSED: the browser has given up and will not try again. */
const CLOSED = 2;

export class HttpRunsApi implements RunsApi {
  #base: string;
  #fetch: typeof fetch;
  #eventSource: (url: string) => EventSource;
  #reconnectDelayMs: number;
  #staleAfterMs: number;
  #onUnauthorized: () => void;

  constructor(options: HttpRunsApiOptions = {}) {
    this.#base = options.base ?? "/api";
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
    this.#eventSource = options.eventSource ?? ((url) => new EventSource(url));
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 2000;
    // The server pings every 15 s: three missed are a dead stream.
    this.#staleAfterMs = options.staleAfterMs ?? 45_000;
    this.#onUnauthorized = options.onUnauthorized ?? (() => {});
  }

  session = async (): Promise<Session> => {
    const response = await this.#fetch(`${this.#base}/session`).catch(
      () => null,
    );
    // Only a missing /session means a local server with nothing to sign in to;
    // any other failure asks for the token rather than letting anyone in.
    // No answer at all is a server that is down: the page says so, and nothing
    // of the Runs can leak from it.
    if (!response || response.status === 404)
      return { required: false, signedIn: true };
    if (!response.ok) return { required: true, signedIn: false };
    return (await response.json()) as Session;
  };

  signIn = async (token: string): Promise<void> => {
    await this.#call("POST", "/session", { token });
  };

  listRuns = (): Promise<RunSummary[]> => this.#call("GET", "/runs");

  getRun = (runId: string): Promise<RunDetail> =>
    this.#call("GET", `/runs/${encodeURIComponent(runId)}`);

  startRun = (request: StartRunRequest): Promise<RunSummary> =>
    this.#call("POST", "/runs", request);

  screenshotUrl = (runId: string, version: number, order: number): string =>
    `${this.#base}${runPath(runId)}/screenshots/${version}/${order}`;

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
    onReconnect?: () => void,
  ): (() => void) => {
    let seen = after;
    let source: EventSource | null = null;
    let reopen: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let lost = false;
    let heard = Date.now();
    const receive = (message: MessageEvent<string>) => {
      heard = Date.now();
      let event: RunEvent;
      try {
        event = JSON.parse(message.data) as RunEvent;
      } catch {
        return; // Not an event this dashboard can read; the next one may be.
      }
      seen = Math.max(seen, event.seq);
      onEvent(event);
    };
    const open = () => {
      reopen = null;
      // `after` only on a stream the browser did not open itself: when
      // EventSource reconnects on its own it sends Last-Event-ID, which the
      // server reads instead.
      const next = this.#eventSource(
        `${this.#base}/runs/${encodeURIComponent(runId)}/events?after=${seen}`,
      );
      source = next;
      heard = Date.now();
      for (const type of EVENT_TYPES) next.addEventListener(type, receive);
      next.addEventListener("ping", () => (heard = Date.now()));
      next.addEventListener("open", () => {
        if (!lost) return;
        lost = false;
        onReconnect?.();
      });
      next.addEventListener("error", () => {
        lost = true;
        // After a dropped connection the browser tries again by itself. After
        // an error answer (a proxy's, while the server restarts) it gives up,
        // and the page would stay as it was: so a stream it closed is opened
        // again here.
        if (next.readyState === CLOSED && !stopped && !reopen)
          reopen = setTimeout(open, this.#reconnectDelayMs);
      });
    };
    open();
    // A proxy can leave a stream open after the server behind it has gone: no
    // error comes, and the page would stay as it was. A stream that has gone
    // quiet is closed and opened again.
    const watch = setInterval(
      () => {
        if (stopped || reopen || Date.now() - heard < this.#staleAfterMs)
          return;
        lost = true;
        source?.close();
        reopen = setTimeout(open, this.#reconnectDelayMs);
      },
      Math.max(1, Math.floor(this.#staleAfterMs / 3)),
    );
    return () => {
      stopped = true;
      clearInterval(watch);
      if (reopen) clearTimeout(reopen);
      source?.close();
    };
  };

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    // The cookie ran out, or the token changed: ask for it again.
    if (response.status === 401 && path !== "/session") this.#onUnauthorized();
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
