/**
 * The service over real stores and a scripted Orchestrator: a request answers at
 * once, the Run advances in the background, and what it does arrives in order.
 */
import {
  IllegalTransitionError,
  MissingKeyError,
  openDatabase,
  SqliteDocumentStore,
  SqliteEscalationStore,
  SqliteRunStore,
  SqliteSliceStore,
  SqliteReviewStore,
  SqliteTaskStore,
  type Run,
  type RunOrchestrator,
  type RunMemoryState,
  type RunProgress,
  type Task,
} from "@sdlc-code/core";
import { firstValueFrom, take, toArray } from "rxjs";
import { describe, expect, it } from "vitest";
import { MemoryEventLog } from "./eventLog.js";
import {
  DocumentNotFoundError,
  RunConflictError,
  RunNotFoundError,
  RuntimeUnavailableError,
  type RunLifecycle,
  type RunService,
  type StreamedEvent,
} from "./runService.js";
import {
  issueSummary,
  retriesSpent,
  RuntimeRunService,
  type ServiceRuntime,
} from "./runtimeRunService.js";

type Step = (run: Run) => RunProgress | Promise<RunProgress>;

const TARGET = {
  owner: "local",
  name: "app",
  baseBranch: "main",
  runBranch: "sdlc/run",
};

function setup(
  steps: Step[] = [],
  options: { failResume?: ReadonlySet<string>; refuse?: Error } = {},
) {
  const db = openDatabase(":memory:");
  const store = { db };
  const runs = new SqliteRunStore(store);
  const escalations = new SqliteEscalationStore(store);
  const tasks = new SqliteTaskStore(store);
  const documents = new SqliteDocumentStore(store);
  const slices = new SqliteSliceStore(store);
  const reviews = new SqliteReviewStore(store);
  const log = new MemoryEventLog();
  const script = [...steps];
  const advanced: string[] = [];
  const decisions: string[] = [];
  let closed = 0;

  const orchestrator: RunOrchestrator = {
    advance: async (runId) => {
      advanced.push(runId);
      const run = runs.getRun(runId)!;
      log.publish({
        runId,
        type: "agentTurn",
        role: "systemDesign",
        toolCalls: [],
      });
      const next = script.shift();
      const progress = next ? await next(run) : { finished: "done" as const };
      log.publish({
        runId,
        type: "status",
        status: runs.getRun(runId)!.status,
      });
      return progress;
    },
    decideDesign: (runId) => {
      decisions.push(`design:${runId}`);
      return { outcome: "approved", staleDocuments: [], revisions: [] };
    },
    // As the real one: refusals are plain Errors or illegal moves.
    resolveEscalation: (runId, resolution) => {
      if (options.refuse) throw options.refuse;
      decisions.push(`escalation:${resolution.choice}`);
    },
    decidePullRequest: (runId) => {
      throw new Error(`Run ${runId} has no open PR Gate.`);
    },
  };

  const runtime: ServiceRuntime = {
    runs,
    documents,
    slices,
    tasks,
    escalations,
    reviews,
    orchestrator,
    startRun: async (request) => {
      if (request.targetRepo)
        throw new MissingKeyError("GITHUB_TOKEN", "a Target Repo needs it.");
      return runs.createRun({
        projectRequest: request.projectRequest,
        mode: request.mode,
        targetRepo: TARGET,
        stackProfile: "react-node",
        tokenBudget: request.tokenBudget,
      });
    },
    resume: async (runId) => {
      if (options.failResume?.has(runId))
        throw new Error("the repository is missing");
      return {
        run: runs.getRun(runId)!,
        discardedSteps: 0,
        hadCheckpoint: false,
      };
    },
    redact: (text) => text.replaceAll("secret-key", "[redacted]"),
    close: async () => {
      closed++;
    },
  };
  const service = new RuntimeRunService({
    runtime: () => runtime,
    made: () => true,
    log,
  });
  // Tests depend on the interfaces; only this factory knows the class.
  const api: RunService = service;
  const lifecycle: RunLifecycle = service;
  return {
    api,
    lifecycle,
    settled: service.settled,
    runs,
    tasks,
    documents,
    slices,
    reviews,
    escalations,
    log,
    advanced,
    decisions,
    closed: () => closed,
  };
}

const request = {
  projectRequest: "Build a todo app",
  mode: "gated" as const,
  tokenBudget: 1_000_000,
};

describe("RuntimeRunService: starting and advancing", () => {
  it("answers a new Run at once, and advances it in the background", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { api, settled, advanced } = setup([
      async () => {
        await held;
        return { waitingFor: "designGate" };
      },
    ]);

    const run = await api.startRun(request);

    // The request did not wait for the Run to get anywhere.
    expect(run.status).toBe("designing");
    expect(api.getRun(run.id).advancing).toBe(true);

    release();
    await settled();

    expect(advanced).toEqual([run.id]);
    expect(api.getRun(run.id).advancing).toBe(false);
  });

  // Found out at the start rather than after hours of work that cannot be pushed.
  it("says the server cannot take a Target Repo without GITHUB_TOKEN", async () => {
    const { api } = setup();

    await expect(
      api.startRun({ ...request, targetRepo: "ChinGuang/demo" }),
    ).rejects.toBeInstanceOf(RuntimeUnavailableError);
  });

  it("records a decision, answers with the Run, and advances it again", async () => {
    const { api, settled, advanced, decisions } = setup([
      () => ({ waitingFor: "designGate" }),
    ]);
    const run = await api.startRun(request);
    await settled();

    api.decideDesign(run.id, [
      { documentKind: "systemDesign", decision: "approve", comments: "" },
    ]);
    await settled();

    expect(decisions).toEqual([`design:${run.id}`]);
    expect(advanced).toEqual([run.id, run.id]);
  });

  // Advancing twice at once would run two Steps of one Run in parallel.
  it("advances a Run once at a time, and again for a decision made meanwhile", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { api, settled, advanced } = setup([
      async () => {
        await held;
        return { waitingFor: "designGate" };
      },
    ]);
    const run = await api.startRun(request);

    api.resolveEscalation(run.id, { choice: "skipSlice" });
    api.resolveEscalation(run.id, { choice: "skipSlice" });
    release();
    await settled();

    // The first loop, then exactly one more for the decisions it did not see.
    expect(advanced).toEqual([run.id, run.id]);
  });

  it("tells the Run's followers when advancing it threw, with keys taken out", async () => {
    const { api, settled } = setup([
      () => {
        throw new Error("Token Factory refused key secret-key.");
      },
    ]);
    const run = await api.startRun(request);
    await settled();

    const events = await firstValueFrom(
      api.events(run.id, 0).pipe(take(2), toArray()),
    );

    expect(events[1]).toMatchObject({
      type: "problem",
      problem: "The Run stopped: Token Factory refused key [redacted].",
    });
  });
});

describe("RuntimeRunService.getRun", () => {
  // A Slice's lanes: each agent's Task, how often it was sent back, its Steps.
  it("shows each agent's Task and its Steps, and never a Transcript", async () => {
    const { api, settled, tasks } = setup([
      () => ({ waitingFor: "designGate" }),
    ]);
    const run = await api.startRun(request);
    await settled();
    const task = tasks.createTask({
      runId: run.id,
      sliceId: null,
      agentRole: "backendCoding",
    });
    const step = tasks.startStep(task.id);
    tasks.appendStepEvent(step.id, "message", { secret: "transcript" });
    tasks.completeStep(step.id, "- wrote the route");

    const detail = api.getRun(run.id);

    expect(detail.tasks).toEqual([
      {
        id: task.id,
        sliceId: null,
        role: "backendCoding",
        status: "pending",
        retriesSpent: 0,
        steps: [
          {
            id: step.id,
            status: "completed",
            startedAt: expect.any(String),
            endedAt: expect.any(String),
          },
        ],
      },
    ]);
    expect(JSON.stringify(detail)).not.toContain("transcript");
  });
});

describe("RuntimeRunService: decisions it refuses", () => {
  it("turns a refusal into a conflict, and advances nothing", async () => {
    const { api, settled, advanced } = setup([
      () => ({ waitingFor: "prGate", pullRequest: null }),
    ]);
    const run = await api.startRun(request);
    await settled();

    expect(() => api.decidePullRequest(run.id, { choice: "approve" })).toThrow(
      RunConflictError,
    );
    expect(advanced).toEqual([run.id]);
  });

  it("counts a move the lifecycle does not allow as a refusal too", async () => {
    const { api, settled } = setup([], {
      refuse: new IllegalTransitionError("Run", "building", "abort"),
    });
    const run = await api.startRun(request);
    await settled();

    expect(() =>
      api.resolveEscalation(run.id, { choice: "skipSlice" }),
    ).toThrow(RunConflictError);
  });

  // A fault is not something the person can fix, so it is not a 409.
  it("lets any other fault through as it is", async () => {
    class DatabaseFault extends Error {}
    const { api, settled } = setup([], {
      refuse: new DatabaseFault("disk I/O error"),
    });
    const run = await api.startRun(request);
    await settled();

    expect(() =>
      api.resolveEscalation(run.id, { choice: "skipSlice" }),
    ).toThrow(DatabaseFault);
  });

  it("says so when there is no such Run", () => {
    const { api } = setup();

    expect(() => api.getRun("nope")).toThrow(RunNotFoundError);
    expect(() => api.events("nope")).toThrow(RunNotFoundError);
  });
});

describe("RuntimeRunService: what a person decides on", () => {
  /** A Run with some of its design documents written and in review. */
  async function withDesignDocuments() {
    const context = setup();
    const run = await context.api.startRun(request);
    await context.settled();
    for (const kind of ["systemDesign", "apiContract", "uiSpec"] as const) {
      context.documents.createDocument({
        runId: run.id,
        kind,
        content: `${kind} v1`,
      });
      context.documents.applyEvent(run.id, kind, "ownerFinished");
    }
    return { ...context, run };
  }

  it("reads a document in full, and says when it is not there", async () => {
    const { api, run } = await withDesignDocuments();

    expect(api.getDocument(run.id, "apiContract")).toEqual({
      kind: "apiContract",
      version: 1,
      status: "inReview",
      ownerAgent: "systemDesign",
      content: "apiContract v1",
    });
    expect(() => api.getDocument(run.id, "penpotDesign")).toThrow(
      DocumentNotFoundError,
    );
  });

  // The warning before a person asks for changes to a System Design document.
  it("says which documents a change to each would make Stale", async () => {
    const { api, run } = await withDesignDocuments();

    const documents = api.getRun(run.id).documents;

    expect(
      Object.fromEntries(
        documents.map(({ kind, wouldMakeStale }) => [kind, wouldMakeStale]),
      ),
    ).toEqual({
      systemDesign: ["uiSpec"],
      apiContract: ["uiSpec"],
      uiSpec: [],
    });
  });

  it("shows every review's Findings, as the PR Gate lists them", async () => {
    const { api, reviews, settled } = setup();
    const run = await api.startRun(request);
    await settled();
    reviews.saveReview(run.id, {
      findings: [
        {
          ruleId: "REUSE-01",
          file: "src/server/notes.ts",
          line: 42,
          message: "Duplicated tag parsing.",
          severity: "major",
          source: "codeReview",
        },
      ],
      stopReason: "answered",
      problems: [],
    });

    expect(api.getRun(run.id).reviews).toEqual([
      {
        findings: [
          {
            ruleId: "REUSE-01",
            severity: "major",
            source: "codeReview",
            file: "src/server/notes.ts",
            line: 42,
            message: "Duplicated tag parsing.",
            suggestion: null,
          },
        ],
        stopReason: "answered",
        problems: [],
        createdAt: expect.any(String),
      },
    ]);
  });

  // What a person needs to give a hint that helps: what failed, and what
  // each agent already tried.
  it("shows an Escalation's Slice, its Issues and each agent's last note", async () => {
    const { api, settled, runs, escalations, slices, tasks } = setup();
    const run = await api.startRun(request);
    await settled();
    const [slice] = slices.saveSlices(run.id, [
      { title: "Bookings", isWalkingSkeleton: false },
    ]);
    const task = tasks.createTask({
      runId: run.id,
      sliceId: slice!.id,
      agentRole: "backendCoding",
    });
    tasks.completeStep(tasks.startStep(task.id).id, "Tried UTC; still 409.");
    runs.applyEvent(run.id, { type: "documentsReady" });
    runs.applyEvent(run.id, { type: "designApproved" });
    runs.applyEvent(run.id, { type: "limitHit", trigger: "loop" });
    escalations.openEscalation(run.id, {
      trigger: "loop",
      summary: "The same failure came back.",
      slice: "Bookings",
      reports: [
        {
          step: "smoke",
          failingTest: "POST /api/bookings",
          file: null,
          endpoint: "POST /api/bookings",
          error: "409 Conflict",
          evidence: "a long log",
          suspectedOwner: "backendCoding",
          signature: "x",
          occurrences: 2,
        },
      ],
    });

    expect(api.getRun(run.id).waiting).toEqual({
      for: "escalation",
      id: expect.any(String),
      trigger: "loop",
      summary: "The same failure came back.",
      slice: "Bookings",
      reports: [
        {
          step: "smoke",
          failingTest: "POST /api/bookings",
          file: null,
          endpoint: "POST /api/bookings",
          error: "409 Conflict",
          suspectedOwner: "backendCoding",
          occurrences: 2,
        },
      ],
      workingMemory: [{ role: "backendCoding", note: "Tried UTC; still 409." }],
      openDraftPrOnAbort: true,
    });
  });
});

describe("issueSummary", () => {
  it("shows what a stored report has, and never its evidence", () => {
    expect(issueSummary({ error: "boom", evidence: "secret log" })).toEqual({
      step: "unknown",
      failingTest: null,
      file: null,
      endpoint: null,
      error: "boom",
      suspectedOwner: null,
      occurrences: 1,
    });
    expect(issueSummary(null).error).toBe("(no error recorded)");
    expect(issueSummary({ suspectedOwner: "someoneElse" }).suspectedOwner).toBe(
      null,
    );
  });
});

describe("RuntimeRunService.abortRun", () => {
  it("aborts at an Escalation, with the person's choice about the Draft PR", async () => {
    const { api, settled, runs, escalations, decisions } = setup();
    const run = await api.startRun(request);
    await settled();
    runs.applyEvent(run.id, { type: "documentsReady" });
    runs.applyEvent(run.id, { type: "designApproved" });
    runs.applyEvent(run.id, { type: "limitHit", trigger: "retryBudget" });
    escalations.openEscalation(run.id, {
      trigger: "retryBudget",
      summary: "Still failing",
    });

    api.abortRun(run.id, false);

    expect(decisions).toEqual(["escalation:abort"]);
  });

  // Aborting is an Escalation's choice (CONTEXT.md); a Run that is building
  // has no way out yet but to be stopped.
  it("refuses a Run that is not at an Escalation", async () => {
    const { api, settled, decisions } = setup();
    const run = await api.startRun(request);
    await settled();

    expect(() => api.abortRun(run.id, true)).toThrow(/not at an Escalation/);
    expect(decisions).toEqual([]);
  });
});

describe("RuntimeRunService: the event stream", () => {
  it("sends a Run's events in the order they happened, numbered", async () => {
    const { api, settled } = setup();
    const run = await api.startRun(request);
    await settled();

    const events = await firstValueFrom(
      api.events(run.id, 0).pipe(take(2), toArray()),
    );

    expect(events.map((event) => event.type)).toEqual(["agentTurn", "status"]);
    expect(events[1]!.seq).toBeGreaterThan(events[0]!.seq);
  });

  it("sends only this Run's events, and only from now on without `after`", async () => {
    const { api, settled, log } = setup([
      () => ({ waitingFor: "designGate" }),
      () => ({ waitingFor: "designGate" }),
    ]);
    const first = await api.startRun(request);
    const second = await api.startRun(request);
    await settled();

    const received: StreamedEvent[] = [];
    const subscription = api
      .events(first.id)
      .subscribe((event) => received.push(event));
    log.publish({ runId: second.id, type: "problem", problem: "not yours" });
    log.publish({ runId: first.id, type: "problem", problem: "yours" });
    subscription.unsubscribe();

    expect(
      received.map((event) => event.type === "problem" && event.problem),
    ).toEqual(["yours"]);
  });

  // Read the Run, then follow it from its lastSeq: nothing in between is lost.
  it("gives a Run's last event number, to follow it from without a gap", async () => {
    const { api, settled, log } = setup([() => ({ waitingFor: "designGate" })]);
    const run = await api.startRun(request);
    await settled();
    const { lastSeq } = api.getRun(run.id);

    const received: StreamedEvent[] = [];
    const subscription = api
      .events(run.id, lastSeq)
      .subscribe((event) => received.push(event));
    log.publish({ runId: run.id, type: "problem", problem: "next" });
    subscription.unsubscribe();

    expect(received.map((event) => event.type)).toEqual(["problem"]);
  });

  it("replays what a reconnecting client missed, then carries on live", async () => {
    const { api, settled, log } = setup([() => ({ waitingFor: "designGate" })]);
    const run = await api.startRun(request);
    await settled();
    const [first] = await firstValueFrom(
      api.events(run.id, 0).pipe(take(1), toArray()),
    );

    const received: StreamedEvent[] = [];
    const subscription = api
      .events(run.id, first!.seq)
      .subscribe((event) => received.push(event));
    log.publish({ runId: run.id, type: "problem", problem: "live" });
    subscription.unsubscribe();

    expect(received.map((event) => event.type)).toEqual(["status", "problem"]);
  });
});

describe("RuntimeRunService as the server starts and stops", () => {
  it("resumes every unfinished Run on start, and advances each", async () => {
    const { lifecycle, settled, runs, advanced } = setup();
    const unfinished = runs.createRun({
      ...request,
      targetRepo: TARGET,
      stackProfile: "react-node",
    });

    const { resumed, failed } = await lifecycle.resumeUnfinished();
    await settled();

    expect(resumed).toEqual([unfinished.id]);
    expect(failed).toEqual([]);
    expect(advanced).toEqual([unfinished.id]);
  });

  it("resumes the others when one cannot be, and says which", async () => {
    // Filled in once the Run exists: its id is what the fake refuses.
    const failing = new Set<string>();
    const { lifecycle, settled, runs, advanced } = setup([], {
      failResume: failing,
    });
    const unfinished = () =>
      runs.createRun({
        ...request,
        targetRepo: TARGET,
        stackProfile: "react-node",
      });
    const broken = unfinished();
    const fine = unfinished();
    failing.add(broken.id);

    const { resumed, failed } = await lifecycle.resumeUnfinished();
    await settled();

    expect(resumed).toEqual([fine.id]);
    expect(failed).toEqual([
      { runId: broken.id, problem: "the repository is missing" },
    ]);
    expect(advanced).toEqual([fine.id]);
  });

  it("closes the runtime when the server stops", async () => {
    const { lifecycle, closed } = setup();

    await lifecycle.shutdown();

    expect(closed()).toBe(1);
  });

  it("lists every Run, newest first", async () => {
    const { api, settled } = setup();
    const first = await api.startRun(request);
    const second = await api.startRun(request);
    await settled();

    expect(api.listRuns().map((run) => run.id)).toEqual([second.id, first.id]);
  });
});

describe("retriesSpent", () => {
  const memory = (
    histories: Record<string, Partial<Record<"backend" | "frontend", number>>>,
    hinted: string[] = [],
  ): RunMemoryState => ({
    revisions: [],
    histories: new Map(
      Object.entries(histories).map(([sliceId, retryBaseline]) => [
        sliceId,
        { earlier: { backend: [], frontend: [], design: [] }, retryBaseline },
      ]),
    ),
    hints: new Map(
      hinted.map((sliceId) => [
        sliceId,
        { from: "person" as const, issues: [] },
      ]),
    ),
    reviewRetries: 0,
  });
  const task = (
    retries: number,
    agentRole: Task["agentRole"] = "backendCoding",
  ) => ({
    sliceId: "s1",
    agentRole,
    retries,
  });

  it("counts every retry on a Slice's first budget", () => {
    expect(retriesSpent(task(2), null)).toBe(2);
    expect(retriesSpent(task(2), memory({}))).toBe(2);
  });

  // The count behind "Retry 1/3": never more than the budget a hint refilled.
  it("counts from the baseline a hint moved up, per side", () => {
    const refilled = memory({ s1: { backend: 3, frontend: 1 } });

    expect(retriesSpent(task(4), refilled)).toBe(1);
    expect(retriesSpent(task(1, "frontendCoding"), refilled)).toBe(0);
  });

  it("counts none for a Slice whose hint is still to be taken up", () => {
    expect(retriesSpent(task(3), memory({ s1: { backend: 0 } }, ["s1"]))).toBe(
      0,
    );
  });
});
