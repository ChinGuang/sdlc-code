/**
 * `sdlccode` against a mock server over real HTTP: what each command sends,
 * what it prints, and the exit code a script can rely on (0 done, 1 refused,
 * 2 mistyped).
 */
import { afterEach, describe, expect, it } from "vitest";
import { HttpServerApi, type RunDetail, type RunSummary } from "./api.js";
import { runCli } from "./cli.js";
import { PLAIN } from "./format.js";
import { mockServer, type Route } from "./testing/mockServer.js";

const ID = "27f388b4-ab2b-4506-9dd4-966b0e7aeeda";
const OTHER = "27aa0000-0000-4000-8000-000000000000";

const SUMMARY: RunSummary = {
  id: ID,
  projectRequest: "A calendar app",
  mode: "gated",
  status: "building",
  tokensUsed: 612_000,
  tokenBudget: 2_000_000,
  pullRequest: null,
  createdAt: "2026-09-30T09:00:00.000Z",
  updatedAt: "2026-09-30T09:58:00.000Z",
};

const DETAIL: RunDetail = {
  ...SUMMARY,
  slices: [
    {
      id: "s1",
      title: "Walking Skeleton",
      status: "passed",
      isWalkingSkeleton: true,
      commitSha: "3f9a2c1ffff",
    },
    {
      id: "s2",
      title: "Auth",
      status: "building",
      isWalkingSkeleton: false,
      commitSha: null,
    },
    {
      id: "s3",
      title: "Todos",
      status: "pending",
      isWalkingSkeleton: false,
      commitSha: null,
    },
  ],
  documents: [
    {
      kind: "systemDesign",
      version: 1,
      status: "inReview",
      ownerAgent: "systemDesign",
      wouldMakeStale: ["uiSpec", "penpotDesign"],
    },
    {
      kind: "apiContract",
      version: 1,
      status: "inReview",
      ownerAgent: "systemDesign",
      wouldMakeStale: ["uiSpec", "penpotDesign"],
    },
    {
      kind: "uiSpec",
      version: 1,
      status: "inReview",
      ownerAgent: "uiDesign",
      wouldMakeStale: [],
    },
    {
      kind: "penpotDesign",
      version: 1,
      status: "inReview",
      ownerAgent: "uiDesign",
      wouldMakeStale: [],
    },
  ],
  reviews: [],
  tasks: [
    {
      id: "t1",
      sliceId: "s2",
      role: "backendCoding",
      status: "running",
      retriesSpent: 1,
      steps: [{ id: "x", status: "running" }],
    },
  ],
  waiting: { for: "nothing" },
  failure: null,
  advancing: true,
  lastSeq: 40,
};

const AT_DESIGN_GATE: RunDetail = {
  ...DETAIL,
  status: "awaitingDesignGate",
  slices: [],
  tasks: [],
  waiting: {
    for: "designGate",
    documents: [
      { kind: "systemDesign", version: 1 },
      { kind: "apiContract", version: 1 },
      { kind: "uiSpec", version: 1 },
      { kind: "penpotDesign", version: 1 },
    ],
  },
};

const ESCALATED: RunDetail = {
  ...DETAIL,
  status: "escalated",
  tokensUsed: 2_005_052,
  tokenBudget: 2_000_000,
  waiting: {
    for: "escalation",
    id: "e1",
    trigger: "retryBudget",
    summary: "Still failing after 3 retries: GET /health",
    slice: "Auth",
    reports: [
      {
        step: "unit",
        failingTest: "GET /health > reports the API is healthy",
        file: "server/app.test.ts",
        endpoint: "GET /health",
        error: "expected { status: 'ok' } to match { database: 'up' }",
        suspectedOwner: "backendCoding",
        occurrences: 1,
      },
    ],
    workingMemory: [
      { role: "backendCoding", note: "Aligned /health with the API Contract." },
    ],
    openDraftPrOnAbort: true,
  },
};

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** The CLI against a server answering `detail` for the Run, and `route` first. */
async function cli(detail: RunDetail, route: Route = () => undefined) {
  const server = await mockServer((request) => {
    const answer = route(request);
    if (answer) return answer;
    if (request.method === "GET" && request.path === "/runs")
      return {
        json: [detail, { ...SUMMARY, id: OTHER, projectRequest: "Blog" }],
      };
    if (request.method === "GET" && request.path === `/runs/${ID}`)
      return { json: detail };
    if (request.method === "POST") return { json: detail };
    return undefined;
  });
  servers.push(server);
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) =>
    runCli(
      argv,
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      {
        api: new HttpServerApi({ baseUrl: server.url }),
        paint: PLAIN,
        dashboardUrl: "http://localhost:5173",
      },
    );
  const posted = () =>
    server.requests
      .filter((request) => request.method === "POST")
      .map(({ path, body }) => [path, body]);
  return { run, out, err, posted, requests: server.requests };
}

describe("sdlccode: help and mistakes", () => {
  it("prints its version and its commands", async () => {
    const { run, out } = await cli(DETAIL);

    expect(await run("--version")).toBe(0);
    expect(await run()).toBe(0);

    expect(out[0]).toBe("sdlccode 0.1.0");
    for (const command of [
      "run",
      "status",
      "gate approve",
      "gate request-changes",
      "escalation retry",
      "abort",
    ])
      expect(out[1]).toContain(command);
  });

  it("answers 2 for what it does not know, and says how to find out", async () => {
    const { run, err } = await cli(DETAIL);

    expect(await run("deploy")).toBe(2);
    expect(await run("gate", "open", "27f388")).toBe(2);
    expect(await run("status", "27f388", "--folow")).toBe(2);

    expect(err.join("\n")).toMatch(/Unknown command: deploy/);
    expect(err.join("\n")).toMatch(
      /gate needs show, approve or request-changes, not "open"/,
    );
    expect(err.join("\n")).toMatch(/Unknown option --folow/);
    expect(err[0]).toMatch(/sdlccode --help/);
  });

  it("finds a Run by its first characters, and asks for more when two match", async () => {
    const { run, err } = await cli(DETAIL);

    expect(await run("status", "#27f3")).toBe(0);
    expect(await run("status", "27")).toBe(2);
    expect(await run("status", "ffff")).toBe(1);

    expect(err.join("\n")).toMatch(/"27" starts 2 Runs: 27f388, 27aa00/);
    expect(err.join("\n")).toMatch(/No Run starts with "ffff"/);
  });

  it("says how to start the server when there is none", async () => {
    const out: string[] = [];
    const err: string[] = [];

    const code = await runCli(
      ["list"],
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      {
        api: new HttpServerApi({ baseUrl: "http://127.0.0.1:1" }),
        paint: PLAIN,
        dashboardUrl: "",
      },
    );

    expect(code).toBe(1);
    expect(err[0]).toMatch(
      /No sdlc-code server at http:\/\/127.0.0.1:1\. Start it with/,
    );
  });
});

describe("sdlccode run", () => {
  it("starts a gated Run with the request, and follows it until it needs a person", async () => {
    let read = 0;
    const { run, out, posted } = await cli(DETAIL, (request) => {
      if (request.method === "POST" && request.path === "/runs")
        return { status: 201, json: SUMMARY };
      if (request.path.startsWith(`/runs/${ID}/events?after=40`))
        return {
          events: [
            {
              type: "step",
              phase: "started",
              role: "systemDesign",
              sliceId: null,
              stepId: "a",
              taskId: "t",
            },
            { type: "status", status: "awaitingDesignGate" },
            { type: "problem", problem: "never printed: the CLI stopped" },
          ],
        };
      // Building when it starts; at the Gate once the stream says so.
      if (request.path === `/runs/${ID}`)
        return { json: (read += 1) === 1 ? DETAIL : AT_DESIGN_GATE };
      return undefined;
    });

    expect(
      await run(
        "run",
        "Build a todo app",
        "--repo",
        "ChinGuang/demo",
        "--budget",
        "3M",
      ),
    ).toBe(0);

    expect(posted()[0]).toEqual([
      "/runs",
      {
        projectRequest: "Build a todo app",
        mode: "gated",
        tokenBudget: 3_000_000,
        targetRepo: "ChinGuang/demo",
      },
    ]);
    const printed = out.join("\n");
    expect(printed).toMatch(
      /✓ Run #27f388 started {2}· {2}gated {2}· {2}budget 2\.0M tokens/,
    );
    expect(printed).toMatch(/System Design Agent {2}started a Step/);
    expect(printed).toMatch(/Run is now awaiting Design Gate/);
    expect(printed).not.toMatch(/never printed/);
    expect(printed).toMatch(/■ Design Gate: 4 documents to judge/);
    expect(printed).toContain(`http://localhost:5173/#/runs/${ID}/design-gate`);
  });

  it("starts an auto Run and leaves it be with --detach", async () => {
    const { run, out, posted } = await cli(DETAIL, (request) =>
      request.method === "POST" && request.path === "/runs"
        ? { status: 201, json: { ...SUMMARY, mode: "auto" } }
        : undefined,
    );

    expect(await run("run", "Build a blog", "--auto", "--detach")).toBe(0);

    expect(posted()[0]![1]).toMatchObject({
      mode: "auto",
      tokenBudget: 2_000_000,
      targetRepo: null,
    });
    expect(out.at(-1)).toMatch(/sdlccode status 27f388 --follow/);
  });

  it("shows every problem the server found with the request", async () => {
    const { run, err } = await cli(DETAIL, (request) =>
      request.path === "/runs" && request.method === "POST"
        ? {
            status: 400,
            json: {
              message: "The request does not fit.",
              problems: ['targetRepo: a Target Repo is "owner/name"'],
            },
          }
        : undefined,
    );

    expect(await run("run", "x", "--repo", "nope")).toBe(1);

    expect(err).toEqual([
      "The request does not fit.",
      '  targetRepo: a Target Repo is "owner/name"',
    ]);
  });
});

describe("sdlccode status", () => {
  it("shows each Slice, the current one's lanes, and the spend", async () => {
    const { run, out } = await cli(DETAIL);

    expect(await run("status", "27f388")).toBe(0);

    const printed = out.join("\n");
    expect(printed).toMatch(/Slice 1 Walking Skeleton +✓ 3f9a2c1/);
    expect(printed).toMatch(
      /Slice 2 Auth +● coding {2}backend writing {2}retries 1\/3/,
    );
    expect(printed).toMatch(/Slice 3 Todos +pending/);
    expect(printed).toMatch(/tokens 612k \/ 2\.0M/);
  });

  it("with --follow, prints nothing more for a Run already waiting", async () => {
    const { run, out, requests } = await cli(AT_DESIGN_GATE);

    expect(await run("status", "27f388", "--follow")).toBe(0);

    expect(requests.some((request) => request.path.includes("/events"))).toBe(
      false,
    );
    expect(out.join("\n")).toMatch(/Design Gate: 4 documents to judge/);
  });
});

describe("sdlccode gate", () => {
  it("shows the documents in review, and one in full", async () => {
    const { run, out } = await cli(AT_DESIGN_GATE, (request) =>
      request.path === `/runs/${ID}/documents/apiContract`
        ? {
            json: {
              kind: "apiContract",
              version: 1,
              status: "inReview",
              ownerAgent: "systemDesign",
              content: '{"openapi":"3.1.0"}',
            },
          }
        : undefined,
    );

    expect(await run("gate", "show", "27f388")).toBe(0);
    expect(await run("gate", "show", "27f388", "api-contract")).toBe(0);

    const printed = out.join("\n");
    expect(printed).toMatch(/api-contract +in review +System Design Agent/);
    expect(printed).toMatch(/sdlccode gate approve 27f388 --all/);
    expect(printed).toContain('{\n  "openapi": "3.1.0"\n}');
  });

  it("approves every document in review at once", async () => {
    const { run, posted } = await cli(AT_DESIGN_GATE);

    expect(await run("gate", "approve", "27f388", "--all")).toBe(0);

    expect(posted()).toEqual([
      [
        `/runs/${ID}/design-gate`,
        {
          verdicts: [
            "systemDesign",
            "apiContract",
            "uiSpec",
            "penpotDesign",
          ].map((kind) => ({
            documentKind: kind,
            decision: "approve",
            comments: "",
          })),
        },
      ],
    ]);
  });

  // The Gate takes every Verdict at once: the documents named go back, the
  // rest are approved, and what goes Stale is said before it happens.
  it("sends the documents named back, approves the rest, and warns what goes Stale", async () => {
    const { run, out, posted } = await cli(AT_DESIGN_GATE);

    expect(
      await run(
        "gate",
        "request-changes",
        "27f388",
        "api-contract",
        "Add POST /api/auth/logout",
      ),
    ).toBe(0);

    expect(posted()[0]![1]).toEqual({
      verdicts: [
        { documentKind: "systemDesign", decision: "approve", comments: "" },
        {
          documentKind: "apiContract",
          decision: "requestChanges",
          comments: "Add POST /api/auth/logout",
        },
        { documentKind: "uiSpec", decision: "approve", comments: "" },
        { documentKind: "penpotDesign", decision: "approve", comments: "" },
      ],
    });
    expect(out.join("\n")).toMatch(
      /! ui-spec, penpot marked stale: redone before the Gate re-opens/,
    );
  });

  it("refuses a document that does not exist, or comments with no document", async () => {
    const { run, err, posted } = await cli(AT_DESIGN_GATE);

    expect(await run("gate", "request-changes", "27f388", "readme", "x")).toBe(
      2,
    );
    expect(await run("gate", "request-changes", "27f388", "Just fix it")).toBe(
      2,
    );

    expect(err.join("\n")).toMatch(
      /"readme" is not a document; use system-design, slice-plan, api-contract, ui-spec, penpot/,
    );
    expect(posted()).toEqual([]);
  });

  it("approves the pull request at the PR Gate, or sends it back with comments", async () => {
    const atPrGate: RunDetail = {
      ...DETAIL,
      status: "awaitingPrGate",
      waiting: {
        for: "prGate",
        pullRequest: {
          number: 7,
          url: "https://github.com/o/r/pull/7",
          draft: false,
        },
      },
    };
    const { run, posted } = await cli(atPrGate);

    expect(await run("gate", "approve", "27f388")).toBe(0);
    expect(
      await run("gate", "request-changes", "27f388", "Rename the route."),
    ).toBe(0);

    expect(posted()).toEqual([
      [`/runs/${ID}/pr-gate`, { choice: "approve" }],
      [
        `/runs/${ID}/pr-gate`,
        { choice: "requestChanges", comments: "Rename the route." },
      ],
    ]);
  });

  it("says so when no Gate waits", async () => {
    const { run, err } = await cli(DETAIL);

    expect(await run("gate", "approve", "27f388")).toBe(1);

    expect(err[0]).toMatch(/#27f388 is coding: no Gate waits for a decision/);
  });
});

describe("sdlccode escalation and abort", () => {
  it("shows what stopped the Run, what kept failing and what was tried", async () => {
    const { run, out } = await cli(ESCALATED);

    expect(await run("escalation", "show", "27f388")).toBe(0);

    const printed = out.join("\n");
    expect(printed).toMatch(/Still failing after 3 retries: GET \/health/);
    expect(printed).toMatch(
      /unit › GET \/health > reports the API is healthy → expected/,
    );
    expect(printed).toMatch(
      /Backend Coding Agent\n +Aligned \/health with the API Contract\./,
    );
    expect(printed).toMatch(
      /sdlccode escalation retry 27f388 "<hint>" --budget 3\.0M/,
    );
    expect(printed).toMatch(/The Token Budget is spent/);
  });

  it("retries with a hint and a higher budget", async () => {
    const { run, posted } = await cli(ESCALATED);

    expect(
      await run(
        "escalation",
        "retry",
        "27f388",
        "Keep the database field.",
        "--budget",
        "3,000,000",
      ),
    ).toBe(0);

    expect(posted()).toEqual([
      [
        `/runs/${ID}/escalation`,
        {
          choice: "retryWithHint",
          hint: "Keep the database field.",
          tokenBudget: 3_000_000,
        },
      ],
    ]);
  });

  it("sends a document back, or skips the Slice", async () => {
    const { run, posted } = await cli(ESCALATED);

    expect(
      await run(
        "escalation",
        "edit",
        "27f388",
        "api-contract",
        "Add database to /health.",
      ),
    ).toBe(0);
    expect(await run("escalation", "skip", "27f388", "--budget=2.5M")).toBe(0);

    expect(posted()).toEqual([
      [
        `/runs/${ID}/escalation`,
        {
          choice: "editDocuments",
          edits: [
            {
              documentKind: "apiContract",
              comments: "Add database to /health.",
            },
          ],
        },
      ],
      [
        `/runs/${ID}/escalation`,
        { choice: "skipSlice", tokenBudget: 2_500_000 },
      ],
    ]);
  });

  it("passes the server's refusal on, as a person reads it", async () => {
    const { run, err } = await cli(ESCALATED, (request) =>
      request.method === "POST"
        ? {
            status: 409,
            json: {
              statusCode: 409,
              message:
                "The Token Budget is spent: raise it to go on, or abort the Run.",
            },
          }
        : undefined,
    );

    expect(await run("escalation", "skip", "27f388")).toBe(1);

    expect(err[0]).toBe(
      "The Token Budget is spent: raise it to go on, or abort the Run.",
    );
  });

  // The plan's criterion: abort says whether to open a Draft PR.
  it("aborts with a Draft PR unless told --no-draft-pr", async () => {
    const { run, posted } = await cli(ESCALATED);

    expect(await run("abort", "27f388")).toBe(0);
    expect(await run("abort", "27f388", "--no-draft-pr")).toBe(0);

    expect(posted()).toEqual([
      [`/runs/${ID}/abort`, { openDraftPrOnAbort: true }],
      [`/runs/${ID}/abort`, { openDraftPrOnAbort: false }],
    ]);
  });
});
