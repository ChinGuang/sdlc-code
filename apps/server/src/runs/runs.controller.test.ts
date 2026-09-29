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
import {
  RUN_SERVICE,
  RunConflictError,
  RunNotFoundError,
  RuntimeUnavailableError,
  type RunDetail,
  type RunService,
  type StreamedEvent,
  type Waiting,
} from "./runService.js";

// Each test boots a Nest application: slow on Windows and under a full suite.
vi.setConfig({ testTimeout: 60_000 });

const apps: INestApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const RUN_ID = "run-1";

function detail(waiting: Waiting = { for: "nothing" }): RunDetail {
  return {
    id: RUN_ID,
    projectRequest: "Build a todo app",
    mode: "gated",
    status: "designing",
    tokensUsed: 0,
    tokenBudget: 2_000_000,
    pullRequest: null,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    slices: [],
    documents: [],
    waiting,
    failure: null,
    advancing: false,
  };
}

/** A RunService that records what it was asked and answers from a script. */
function fakeService(overrides: Partial<RunService> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const stream = new Subject<StreamedEvent>();
  const record =
    <T>(name: string, answer: T) =>
    (...args: unknown[]) => {
      calls.push([name, args]);
      return answer;
    };
  const service: RunService = {
    startRun: async (request) => {
      calls.push(["startRun", [request]]);
      return detail();
    },
    listRuns: record("listRuns", [detail()]),
    getRun: (id) => {
      if (id !== RUN_ID) throw new RunNotFoundError(id);
      return detail();
    },
    decideDesign: record("decideDesign", detail()),
    resolveEscalation: record("resolveEscalation", detail()),
    decidePullRequest: record("decidePullRequest", detail()),
    events: (id, after) => {
      calls.push(["events", [id, after]]);
      return stream.asObservable();
    },
    ...overrides,
  };
  return { service, calls, stream };
}

async function start(service: RunService): Promise<string> {
  const app = (
    await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RUN_SERVICE)
      .useValue(service)
      .compile()
  ).createNestApplication({ logger: false });
  apps.push(app);
  await app.listen(0, "127.0.0.1");
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
    const body = (await response.json()) as { problems: string[] };
    expect(body.problems.join("\n")).toMatch(/projectRequest/);
    expect(body.problems.join("\n")).toMatch(/mode/);
    expect(body.problems.join("\n")).toMatch(/tokenBudget/);
    expect(body.problems.join("\n")).toMatch(/owner\/name/);
    expect(body.problems.join("\n")).toMatch(/surprise/);
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
  it("lists Runs, and reads one with what it is waiting for", async () => {
    const { service } = fakeService();
    const url = await start(service);

    expect(await (await fetch(`${url}/runs`)).json()).toEqual([detail()]);
    expect(await (await fetch(`${url}/runs/${RUN_ID}`)).json()).toEqual(
      detail(),
    );
  });

  it("answers 404 for a Run that does not exist", async () => {
    const { service } = fakeService();
    const url = await start(service);

    const response = await fetch(`${url}/runs/nope`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: "No Run nope." });
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
  const atEscalation: Waiting = {
    for: "escalation",
    trigger: "retryBudget",
    summary: "Still failing",
    openDraftPrOnAbort: true,
  };

  it("aborts at an Escalation, with a Draft PR unless the person unticks it", async () => {
    const { service, calls } = fakeService({
      getRun: () => detail(atEscalation),
    });
    const url = await start(service);

    await post(`${url}/runs/${RUN_ID}/abort`, {});
    await post(`${url}/runs/${RUN_ID}/abort`, { openDraftPr: false });

    expect(calls).toEqual([
      [
        "resolveEscalation",
        [RUN_ID, { choice: "abort", openDraftPrOnAbort: true }],
      ],
      [
        "resolveEscalation",
        [RUN_ID, { choice: "abort", openDraftPrOnAbort: false }],
      ],
    ]);
  });

  // Aborting is an Escalation's choice; there is no other way out of a Run yet.
  it("answers 409 for a Run that is not at an Escalation", async () => {
    const { service, calls } = fakeService();
    const url = await start(service);

    const response = await post(`${url}/runs/${RUN_ID}/abort`, {});

    expect(response.status).toBe(409);
    expect(calls).toEqual([]);
  });
});

describe("GET /runs/:id/events", () => {
  /** Reads Server-Sent Events off the wire until `count` have arrived. */
  async function read(url: string, count: number) {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
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

  const event = (seq: number, type: "status" | "problem"): StreamedEvent =>
    type === "status"
      ? { runId: RUN_ID, seq, happenedAt: "t", type, status: "building" }
      : { runId: RUN_ID, seq, happenedAt: "t", type, problem: `p${seq}` };

  it("streams a Run's events in order, each with its number as the SSE id", async () => {
    const { service, stream } = fakeService();
    const url = await start(service);

    const reading = read(`${url}/runs/${RUN_ID}/events`, 3);
    // Give the client time to connect before anything is sent.
    await new Promise((resolve) => setTimeout(resolve, 200));
    stream.next(event(1, "status"));
    stream.next(event(2, "problem"));
    stream.next(event(3, "problem"));
    const { events, contentType } = await reading;

    expect(contentType).toMatch(/text\/event-stream/);
    expect(events.map(({ id, event }) => [id, event])).toEqual([
      ["1", "status"],
      ["2", "problem"],
      ["3", "problem"],
    ]);
    expect(events[1]!.data).toMatchObject({ problem: "p2" });
  });

  it("passes `after` on, so a reconnecting client catches up", async () => {
    const { service, calls, stream } = fakeService();
    const url = await start(service);

    const reading = read(`${url}/runs/${RUN_ID}/events?after=41`, 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    stream.next(event(42, "status"));
    await reading;

    expect(calls).toContainEqual(["events", [RUN_ID, 41]]);
  });
});
