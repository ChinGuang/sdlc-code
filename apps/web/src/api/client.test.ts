/**
 * The dashboard's HTTP client over a fake fetch and a fake EventSource: where
 * it sends each request, what it makes of a refusal, and how it follows a
 * Run's named SSE events.
 */
import { describe, expect, it, vi } from "vitest";
import { ApiError, HttpRunsApi, type RunsApi } from "./client.js";
import type { RunEvent } from "./types.js";

type Sent = { url: string; init: RequestInit | undefined };

function withFetch(status: number, body: unknown) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, init });
    return new Response(body === null ? "" : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

/** Enough of an EventSource to dispatch named events and be closed. */
class FakeEventSource extends EventTarget {
  url: string;
  closed = false;
  /** 0 connecting, 1 open, 2 closed: what the browser says of the stream. */
  readyState = 1;
  constructor(url: string) {
    super();
    this.url = url;
  }
  close = () => {
    this.closed = true;
    this.readyState = 2;
  };
  /** The connection dropped; a browser tries again by itself. */
  drop = () => {
    this.readyState = 0;
    this.dispatchEvent(new Event("error"));
  };
  /** The server answered with an error (a proxy, mid-restart): it gives up. */
  refused = () => {
    this.readyState = 2;
    this.dispatchEvent(new Event("error"));
  };
  open = () => {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  };
  send = (type: string, data: unknown) =>
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
}

describe("HttpRunsApi", () => {
  it("asks /api for Runs, and sends a new Run as JSON", async () => {
    const { sent, fetch } = withFetch(201, { id: "r1" });
    const api: RunsApi = new HttpRunsApi({ fetch });

    await api.startRun({
      projectRequest: "Todo app",
      mode: "auto",
      tokenBudget: 5,
    });
    await api.getRun("a/b");

    expect(sent[0]!.url).toBe("/api/runs");
    expect(sent[0]!.init?.method).toBe("POST");
    expect(JSON.parse(sent[0]!.init?.body as string)).toEqual({
      projectRequest: "Todo app",
      mode: "auto",
      tokenBudget: 5,
    });
    expect(sent[1]!.url).toBe("/api/runs/a%2Fb");
  });

  // Each decision goes to its own route, and answers with the Run.
  it("sends each decision to its route, as the server takes it", async () => {
    const { sent, fetch } = withFetch(200, { id: "r1" });
    const api: RunsApi = new HttpRunsApi({ fetch });

    await api.getDocument("r1", "apiContract");
    await api.decideDesign("r1", [
      { documentKind: "uiSpec", decision: "approve", comments: "" },
    ]);
    await api.resolveEscalation("r1", {
      choice: "abort",
      openDraftPrOnAbort: false,
    });
    await api.decidePullRequest("r1", { choice: "approve" });

    expect(sent.map(({ url, init }) => [init?.method, url])).toEqual([
      ["GET", "/api/runs/r1/documents/apiContract"],
      ["POST", "/api/runs/r1/design-gate"],
      ["POST", "/api/runs/r1/escalation"],
      ["POST", "/api/runs/r1/pr-gate"],
    ]);
    expect(
      sent.slice(1).map(({ init }) => JSON.parse(init?.body as string)),
    ).toEqual([
      {
        verdicts: [
          { documentKind: "uiSpec", decision: "approve", comments: "" },
        ],
      },
      { choice: "abort", openDraftPrOnAbort: false },
      { choice: "approve" },
    ]);
  });

  // The server's 400 names every problem; a person sees each.
  it("turns a refusal into an ApiError with the server's own words", async () => {
    const { fetch } = withFetch(400, {
      message: "The request does not fit.",
      problems: ["tokenBudget: Too small"],
    });
    const api: RunsApi = new HttpRunsApi({ fetch });

    const error = await api
      .startRun({ projectRequest: "x", mode: "auto", tokenBudget: 0 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      message: "The request does not fit.",
      problems: ["tokenBudget: Too small"],
    });
  });

  it("says the status when a refusal has no body", async () => {
    const { fetch } = withFetch(502, null);
    const api: RunsApi = new HttpRunsApi({ fetch });

    await expect(api.listRuns()).rejects.toThrow("The server answered 502.");
  });

  it("finds the server down when /health does not answer", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;

    expect(await new HttpRunsApi({ fetch: down }).serverUp()).toBe(false);
    expect(
      await new HttpRunsApi(withFetch(200, { status: "ok" })).serverUp(),
    ).toBe(true);
  });

  // The server names each message by its type; a "message" listener hears none.
  it("follows a Run's events by name, from where it is told, until stopped", () => {
    const sources: FakeEventSource[] = [];
    const api: RunsApi = new HttpRunsApi({
      eventSource: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source as unknown as EventSource;
      },
    });
    const received: RunEvent[] = [];

    const stop = api.followRun("r1", 41, (event) => received.push(event));
    const [source] = sources;
    source!.send("status", { type: "status", status: "building", seq: 42 });
    source!.send("tokens", { type: "tokens", used: 1, budget: 2, seq: 43 });
    stop();

    expect(source!.url).toBe("/api/runs/r1/events?after=41");
    expect(received.map((event) => event.seq)).toEqual([42, 43]);
    expect(source!.closed).toBe(true);
  });

  describe("when the stream is lost (T25c)", () => {
    function followed() {
      const sources: FakeEventSource[] = [];
      const api: RunsApi = new HttpRunsApi({
        reconnectDelayMs: 100,
        eventSource: (url) => {
          const source = new FakeEventSource(url);
          sources.push(source);
          return source as unknown as EventSource;
        },
      });
      const received: RunEvent[] = [];
      let reconnected = 0;
      const stop = api.followRun(
        "r1",
        0,
        (event) => received.push(event),
        () => (reconnected += 1),
      );
      return { sources, received, stop, reconnected: () => reconnected };
    }

    it("says so when the browser's own reconnect succeeds", () => {
      const { sources, reconnected } = followed();
      const [source] = sources;
      source!.open();
      expect(reconnected()).toBe(0); // the first connection is not a return

      source!.drop();
      source!.open();

      expect(reconnected()).toBe(1);
      expect(sources).toHaveLength(1);
    });

    it("opens a stream the browser gave up on, from the last event seen", () => {
      vi.useFakeTimers();
      try {
        const { sources, reconnected } = followed();
        sources[0]!.send("status", { type: "status", status: "x", seq: 7 });

        sources[0]!.refused();
        vi.advanceTimersByTime(99);
        expect(sources).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(sources).toHaveLength(2);
        expect(sources[1]!.url).toBe("/api/runs/r1/events?after=7");

        sources[1]!.open();
        expect(reconnected()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    // A proxy can hold a stream open after the server behind it has gone.
    it("opens a stream again that has gone quiet, and a ping keeps one alive", () => {
      vi.useFakeTimers();
      try {
        const sources: FakeEventSource[] = [];
        let reconnected = 0;
        const api: RunsApi = new HttpRunsApi({
          reconnectDelayMs: 100,
          staleAfterMs: 3000,
          eventSource: (url) => {
            const source = new FakeEventSource(url);
            sources.push(source);
            return source as unknown as EventSource;
          },
        });
        api.followRun(
          "r1",
          0,
          () => {},
          () => (reconnected += 1),
        );

        for (let i = 0; i < 4; i += 1) {
          vi.advanceTimersByTime(2000);
          sources[0]!.dispatchEvent(new Event("ping"));
        }
        expect(sources).toHaveLength(1); // 8 s, but never 3 s of silence

        vi.advanceTimersByTime(4000); // now it is silent
        expect(sources[0]!.closed).toBe(true);
        vi.advanceTimersByTime(100);
        expect(sources).toHaveLength(2);
        sources[1]!.open();
        expect(reconnected).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps trying while the server is down, and stops when stopped", () => {
      vi.useFakeTimers();
      try {
        const { sources, stop } = followed();

        sources[0]!.refused();
        vi.advanceTimersByTime(100);
        sources[1]!.refused();
        vi.advanceTimersByTime(100);
        expect(sources).toHaveLength(3);

        sources[2]!.refused();
        stop();
        vi.advanceTimersByTime(1000);

        expect(sources).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("skips a message it cannot read, and keeps following", () => {
    let source: FakeEventSource | undefined;
    const api: RunsApi = new HttpRunsApi({
      eventSource: (url) => {
        source = new FakeEventSource(url);
        return source as unknown as EventSource;
      },
    });
    const received: RunEvent[] = [];
    api.followRun("r1", 0, (event) => received.push(event));

    source!.dispatchEvent(new MessageEvent("status", { data: "{not json" }));
    source!.send("status", { type: "status", status: "done", seq: 2 });

    expect(received.map((event) => event.seq)).toEqual([2]);
  });
});
