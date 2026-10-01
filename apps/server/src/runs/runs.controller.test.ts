/**
 * The Runs API over real HTTP, with a fake RunService: what each route accepts,
 * what it answers, and the event stream as a client actually reads it.
 */
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Subject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../app.module.js";
import { configureApp, HOST } from "../configureApp.js";
import {
  RUN_LIFECYCLE,
  RUN_SERVICE,
  DocumentNotFoundError,
  ScreenshotNotFoundError,
  RunConflictError,
  RunNotFoundError,
  RuntimeUnavailableError,
  type RunDetail,
  type RunLifecycle,
  type RunService,
  type RunSummary,
  type StreamedEvent,
} from "./runService.js";

// Each test boots a Nest application: slow on Windows and under a full suite.
vi.setConfig({ testTimeout: 60_000 });

const apps: INestApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const RUN_ID = "run-1";

const SUMMARY: RunSummary = {
  id: RUN_ID,
  projectRequest: "Build a todo app",
  mode: "gated",
  status: "designing",
  tokensUsed: 0,
  tokenBudget: 2_000_000,
  pullRequest: null,
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
  waitingFor: "nothing",
};

const DETAIL: RunDetail = {
  ...SUMMARY,
  slices: [],
  documents: [],
  reviews: [],
  screenshots: [],
  screenshotsVersion: null,
  tasks: [],
  waiting: { for: "nothing" },
  failure: null,
  advancing: false,
  lastSeq: 0,
};

/** A RunService that records what it was asked and answers from a script. */
function fakeService(overrides: Partial<RunService> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const stream = new Subject<StreamedEvent>();
  const recorded =
    <T>(name: string, answer: T) =>
    (...args: unknown[]) => {
      calls.push([name, args]);
      return answer;
    };
  const service: RunService = {
    startRun: async (request) => {
      calls.push(["startRun", [request]]);
      return SUMMARY;
    },
    listRuns: () => [SUMMARY],
    getRun: (id) => {
      if (id !== RUN_ID) throw new RunNotFoundError(id);
      return DETAIL;
    },
    getDocument: (id, kind) => {
      calls.push(["getDocument", [id, kind]]);
      if (kind === "penpotDesign") throw new DocumentNotFoundError(id, kind);
      return {
        kind,
        version: 2,
        status: "inReview",
        ownerAgent: "systemDesign",
        content: "openapi: 3.1.0",
      };
    },
    getScreenshot: (id, version, order) => {
      calls.push(["getScreenshot", [id, version, order]]);
      if (order > 1) throw new ScreenshotNotFoundError(id, version, order);
      return { bytes: Buffer.from("\x89PNG fake"), mimeType: "image/png" };
    },
    decideDesign: recorded("decideDesign", DETAIL),
    retryDesign: recorded("retryDesign", DETAIL),
    resolveEscalation: recorded("resolveEscalation", DETAIL),
    decidePullRequest: recorded("decidePullRequest", DETAIL),
    abortRun: recorded("abortRun", DETAIL),
    events: (id, after) => {
      calls.push(["events", [id, after]]);
      return stream.asObservable();
    },
    ...overrides,
  };
  return { service, calls, stream };
}

/** Starts and stops with the server, touching no real Run. */
const idleLifecycle: RunLifecycle = {
  resumeUnfinished: async () => ({ resumed: [], failed: [] }),
  shutdown: async () => {},
};

async function start(service: RunService): Promise<string> {
  const app = (
    await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RUN_SERVICE)
      .useValue(service)
      .overrideProvider(RUN_LIFECYCLE)
      .useValue(idleLifecycle)
      .compile()
  ).createNestApplication({ logger: false });
  // The configuration main.ts starts with, and the host it listens on.
  configureApp(app);
  apps.push(app);
  await app.listen(0, HOST);
  return app.getUrl();
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /runs", () => {
  it("starts a Run with the defaults filled in", async () => {
    const { service, calls } = fakeService();
    const url = await start(service);

    const response = await post(`${url}/runs`, {
      projectRequest: "  Build a todo app  ",
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(SUMMARY);
    expect(calls).toEqual([
      [
        "startRun",
        [
          {
            projectRequest: "Build a todo app",
            mode: "gated",
            tokenBudget: 2_000_000,
          },
        ],
      ],
    ]);
  });

  it("names every problem with a request that does not fit, at once", async () => {
    const { service, calls } = fakeService();
    const url = await start(service);

    const response = await post(`${url}/runs`, {
      projectRequest: "",
      mode: "sometimes",
      tokenBudget: -1,
      targetRepo: "not a repo",
      surprise: true,
    });

    expect(response.status).toBe(400);
    const problems = (
      (await response.json()) as { problems: string[] }
    ).problems.join("\n");
    for (const field of [
      "projectRequest",
      "mode",
      "tokenBudget",
      "owner/name",
      "surprise",
    ])
      expect(problems).toContain(field);
    expect(calls).toEqual([]);
  });

  // A server started without NEBIUS_API_KEY still answers, and says why not.
  it("answers 503 with the reason when the server cannot run anything", async () => {
    const { service } = fakeService({
      startRun: async () => {
        throw new RuntimeUnavailableError(
          "The server cannot run anything yet: NEBIUS_API_KEY is not set.",
        );
      },
    });
    const url = await start(service);

    const response = await post(`${url}/runs`, { projectRequest: "x" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining("NEBIUS_API_KEY is not set"),
    });
  });
});

describe("GET /runs and /runs/:id", () => {
  it("lists Runs as summaries, and reads one in full", async () => {
    const { service } = fakeService();
    const url = await start(service);

    expect(await (await fetch(`${url}/runs`)).json()).toEqual([SUMMARY]);
    expect(await (await fetch(`${url}/runs/${RUN_ID}`)).json()).toEqual(DETAIL);
  });

  it("answers 404 for a Run that does not exist", async () => {
    const { service } = fakeService();
    const url = await start(service);

    const response = await fetch(`${url}/runs/nope`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: "No Run nope." });
  });

  it("reads one document in full for the Design Gate", async () => {
    const { service, calls } = fakeService();
    const url = await start(service);

    const response = await fetch(`${url}/runs/${RUN_ID}/documents/apiContract`);

    expect(await response.json()).toMatchObject({
      kind: "apiContract",
      content: "openapi: 3.1.0",
    });
    expect(calls).toContainEqual(["getDocument", [RUN_ID, "apiContract"]]);
  });

  it("answers 400 for a kind of document no Run has, and 404 for one not written yet", async () => {
    const { service } = fakeService();
    const url = await start(service);

    const unknown = await fetch(`${url}/runs/${RUN_ID}/documents/readme`);
    const missing = await fetch(`${url}/runs/${RUN_ID}/documents/penpotDesign`);

    expect(unknown.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      message: `Run ${RUN_ID} has no penpotDesign document.`,
    });
  });

  // An <img src> gets an image, not JSON.
  it("serves a screenshot as the image it is", async () => {
    const { service, calls } = fakeService();
    const url = await start(service);

    const response = await fetch(`${url}/runs/${RUN_ID}/screenshots/2/1`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "\x89PNG fake",
    );
    expect(calls).toContainEqual(["getScreenshot", [RUN_ID, 2, 1]]);
  });

  it("answers 400 for a screenshot that is not a number, and 404 for one not kept", async () => {
    const { service } = fakeService();
    const url = await start(service);

    const bad = await fetch(`${url}/runs/${RUN_ID}/screenshots/two/1`);
    const missing = await fetch(`${url}/runs/${RUN_ID}/screenshots/2/9`);

    expect(bad.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      message: `Run ${RUN_ID} has no screenshot 9 of design version 2.`,
    });
  });

  // The dashboard is another origin on this machine.
  it("lets a page on this machine call it, and no other", async () => {
    const { service } = fakeService();
    const url = await start(service);
    const from = (origin: string) =>
      fetch(`${url}/runs`, { headers: { origin } }).then((response) =>
        response.headers.get("access-control-allow-origin"),
      );

    expect(await from("http://localhost:5173")).toBe("http://localhost:5173");
    expect(await from("https://example.com")).toBeNull();
  });
});

describe("the Gates and the Escalation", () => {
  it("passes Verdicts on to the Run", async () => {
    const { service, calls } = fakeService();
    const url = await start(service);

    const response = await post(`${url}/runs/${RUN_ID}/design-gate`, {
      verdicts: [
        { documentKind: "systemDesign", decision: "approve" },
        {
          documentKind: "uiSpec",
          decision: "requestChanges",
          comments: "Bigger buttons.",
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      [
        "decideDesign",
        [
          RUN_ID,
          [
            { documentKind: "systemDesign", decision: "approve", comments: "" },
            {
              documentKind: "uiSpec",
              decision: "requestChanges",
              comments: "Bigger buttons.",
            },
          ],
        ],
      ],
    ]);
  });

  it("refuses a Verdict on a document kind that does not exist", async () => {
    const { service } = fakeService();
    const url = await start(service);

    const response = await post(`${url}/runs/${RUN_ID}/design-gate`, {
      verdicts: [{ documentKind: "vibes", decision: "approve" }],
    });

    expect(response.status).toBe(400);
  });

  it("takes each of the four Escalation choices, and refuses an empty hint", async () => {
    const { service, calls } = fakeService();
    const url = await start(service);

    for (const body of [
      { choice: "retryWithHint", hint: "Validate the title." },
      {
        choice: "editDocuments",
        edits: [{ documentKind: "apiContract", comments: "Add a 400." }],
      },
      { choice: "skipSlice" },
      { choice: "abort", openDraftPrOnAbort: false },
    ])
      expect(
        (await post(`${url}/runs/${RUN_ID}/escalation`, body)).status,
      ).toBe(200);

    expect(
      (
        await post(`${url}/runs/${RUN_ID}/escalation`, {
          choice: "retryWithHint",
          hint: "  ",
        })
      ).status,
    ).toBe(400);
    expect(
      calls.map(([name, args]) => [
        name,
        (args[1] as { choice: string }).choice,
      ]),
    ).toEqual([
      ["resolveEscalation", "retryWithHint"],
      ["resolveEscalation", "editDocuments"],
      ["resolveEscalation", "skipSlice"],
      ["resolveEscalation", "abort"],
    ]);
  });

  // A Token Budget Escalation goes on only with more to spend.
  it("passes a raised Token Budget on with the choice", async () => {
    const { service, calls } = fakeService();
    const url = await start(service);

    const response = await post(`${url}/runs/${RUN_ID}/escalation`, {
      choice: "skipSlice",
      tokenBudget: 3_000_000,
    });
    const refused = await post(`${url}/runs/${RUN_ID}/escalation`, {
      choice: "skipSlice",
      tokenBudget: -1,
    });

    expect(response.status).toBe(200);
    expect(refused.status).toBe(400);
    expect(calls).toEqual([
      [
        "resolveEscalation",
        [RUN_ID, { choice: "skipSlice", tokenBudget: 3_000_000 }],
      ],
    ]);
  });

  it("designs a Run again when asked", async () => {
    const { service, calls } = fakeService();
    const url = await start(service);

    const response = await post(`${url}/runs/${RUN_ID}/retry-design`, {});

    expect(response.status).toBe(200);
    expect(calls).toEqual([["retryDesign", [RUN_ID]]]);
  });

  it("answers 409 when the Run is not where the decision needs it", async () => {
    const { service } = fakeService({
      decidePullRequest: () => {
        throw new RunConflictError("Run run-1 has no open PR Gate.");
      },
    });
    const url = await start(service);

    const response = await post(`${url}/runs/${RUN_ID}/pr-gate`, {
      choice: "approve",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      message: "Run run-1 has no open PR Gate.",
    });
  });
});

describe("POST /runs/:id/abort", () => {
  it("asks for a Draft PR unless the person unticks it", async () => {
    const { service, calls } = fakeService();
    const url = await start(service);

    await post(`${url}/runs/${RUN_ID}/abort`, {});
    await post(`${url}/runs/${RUN_ID}/abort`, { openDraftPrOnAbort: false });

    expect(calls).toEqual([
      ["abortRun", [RUN_ID, true]],
      ["abortRun", [RUN_ID, false]],
    ]);
  });

  it("answers 409 for a Run that has finished", async () => {
    const { service } = fakeService({
      abortRun: () => {
        throw new RunConflictError("Run run-1 is done already.");
      },
    });
    const url = await start(service);

    expect((await post(`${url}/runs/${RUN_ID}/abort`, {})).status).toBe(409);
  });
});

describe("GET /runs/:id/events", () => {
  /** Reads Server-Sent Events off the wire until `count` have arrived. */
  async function read(
    url: string,
    count: number,
    headers: Record<string, string> = {},
  ) {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal, headers });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const events: Array<{ id: string; event: string; data: unknown }> = [];
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = text.indexOf("\n\n")) !== -1) {
        const block = text.slice(0, end);
        text = text.slice(end + 2);
        const field = (name: string) =>
          block
            .split("\n")
            .find((line) => line.startsWith(`${name}: `))
            ?.slice(name.length + 2);
        const data = field("data");
        if (data)
          events.push({
            id: field("id")!,
            event: field("event")!,
            data: JSON.parse(data),
          });
      }
    }
    controller.abort();
    return { events, contentType: response.headers.get("content-type") };
  }

  const connected = () => new Promise((resolve) => setTimeout(resolve, 200));

  const step = (
    seq: number,
    phase: "started" | "completed",
  ): StreamedEvent => ({
    runId: RUN_ID,
    seq,
    happenedAt: "t",
    type: "step",
    phase,
    stepId: "step-1",
    taskId: "task-1",
    role: "backendCoding",
    sliceId: "slice-1",
  });

  // The plan's criterion: Step events, in the order they happened.
  it("streams a Run's Step events in order, each with its number as the SSE id", async () => {
    const { service, stream } = fakeService();
    const url = await start(service);

    const reading = read(`${url}/runs/${RUN_ID}/events`, 3);
    await connected();
    stream.next(step(1, "started"));
    stream.next({
      runId: RUN_ID,
      seq: 2,
      happenedAt: "t",
      type: "agentTurn",
      role: "backendCoding",
      toolCalls: ["write_file"],
    });
    stream.next(step(3, "completed"));
    const { events, contentType } = await reading;

    expect(contentType).toMatch(/text\/event-stream/);
    expect(events.map(({ id, event }) => [id, event])).toEqual([
      ["1", "step"],
      ["2", "agentTurn"],
      ["3", "step"],
    ]);
    expect(
      events.map(({ data }) => (data as { phase?: string }).phase),
    ).toEqual(["started", undefined, "completed"]);
  });

  it("passes ?after on, so a reconnecting client catches up", async () => {
    const { service, calls, stream } = fakeService();
    const url = await start(service);

    const reading = read(`${url}/runs/${RUN_ID}/events?after=41`, 1);
    await connected();
    stream.next(step(42, "started"));
    await reading;

    expect(calls).toContainEqual(["events", [RUN_ID, 41]]);
  });

  // A browser's EventSource reconnects on its own and says so in this header.
  it("takes the Last-Event-ID a browser sends when it reconnects", async () => {
    const { service, calls, stream } = fakeService();
    const url = await start(service);

    const reading = read(`${url}/runs/${RUN_ID}/events`, 1, {
      "last-event-id": "57",
    });
    await connected();
    stream.next(step(58, "started"));
    await reading;

    expect(calls).toContainEqual(["events", [RUN_ID, 57]]);
  });

  // It reconnects to the URL it was opened with, whose ?after is out of date.
  it("prefers the Last-Event-ID to the ?after it was first opened with", async () => {
    const { service, calls, stream } = fakeService();
    const url = await start(service);

    const reading = read(`${url}/runs/${RUN_ID}/events?after=41`, 1, {
      "last-event-id": "57",
    });
    await connected();
    stream.next(step(58, "started"));
    await reading;

    expect(calls).toContainEqual(["events", [RUN_ID, 57]]);
  });
});
