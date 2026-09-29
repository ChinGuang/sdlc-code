/**
 * The dashboard's HTTP client over a fake fetch and a fake EventSource: where
 * it sends each request, what it makes of a refusal, and how it follows a
 * Run's named SSE events.
 */
import { describe, expect, it } from "vitest";
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
  constructor(url: string) {
    super();
    this.url = url;
  }
  close = () => {
    this.closed = true;
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
