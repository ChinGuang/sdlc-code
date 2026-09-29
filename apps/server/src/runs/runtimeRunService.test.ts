/**
 * The service over real stores and a scripted Orchestrator: a request answers at
 * once, the Run advances in the background, and what it does arrives in order.
 */
import {
  openDatabase,
  SqliteDocumentStore,
  SqliteEscalationStore,
  SqliteGateStore,
  SqliteRunStore,
  SqliteSliceStore,
  type Run,
  type RunOrchestrator,
  type RunProgress,
} from "@sdlc-code/core";
import { firstValueFrom, take, toArray } from "rxjs";
import { describe, expect, it } from "vitest";
import { MemoryEventLog } from "./eventLog.js";
import {
  RunConflictError,
  RunNotFoundError,
  type RunService,
  type StreamedEvent,
} from "./runService.js";
import { RuntimeRunService, type ServiceRuntime } from "./runtimeRunService.js";

type Step = (run: Run) => RunProgress | Promise<RunProgress>;

function setup(steps: Step[] = []) {
  const db = openDatabase(":memory:");
  const store = { db };
  const runs = new SqliteRunStore(store);
  const log = new MemoryEventLog();
  const script = [...steps];
  const advanced: string[] = [];
  const decisions: string[] = [];

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
    resolveEscalation: (runId, resolution) => {
      if (resolution.choice === "retryWithHint" && !resolution.hint)
        throw new Error("A retry needs a hint for the Coding Agents.");
      decisions.push(`escalation:${resolution.choice}`);
    },
    decidePullRequest: () => {
      throw new Error("Run has no open PR Gate.");
    },
  };

  const runtime: ServiceRuntime = {
    runs,
    documents: new SqliteDocumentStore(store),
    slices: new SqliteSliceStore(store),
    escalations: new SqliteEscalationStore(store),
    gates: new SqliteGateStore(store),
    orchestrator,
    startRun: async (request) =>
      runs.createRun({
        projectRequest: request.projectRequest,
        mode: request.mode,
        targetRepo: {
          owner: "local",
          name: "app",
          baseBranch: "main",
          runBranch: "sdlc/run",
        },
        stackProfile: "react-node",
        tokenBudget: request.tokenBudget,
      }),
    resume: async (runId) => ({
      run: runs.getRun(runId)!,
      discardedSteps: 0,
      hadCheckpoint: false,
    }),
  };
  const service = new RuntimeRunService({ runtime: () => runtime, log });
  // Tests depend on the interface; only this factory knows the class.
  const api: RunService = service;
  return { api, service, runs, log, advanced, decisions };
}

const request = {
  projectRequest: "Build a todo app",
  mode: "gated" as const,
  tokenBudget: 1_000_000,
};

describe("RuntimeRunService", () => {
  it("answers a new Run at once, and advances it in the background", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { api, service, advanced } = setup([
      async () => {
        await gate;
        return { waitingFor: "designGate" };
      },
    ]);

    const run = await api.startRun(request);

    // The request did not wait for the Run to get anywhere.
    expect(run.status).toBe("designing");
    expect(api.getRun(run.id).advancing).toBe(true);

    release();
    await service.settled();

    expect(advanced).toEqual([run.id]);
    expect(api.getRun(run.id).advancing).toBe(false);
  });

  it("sends a Run's events in the order they happened, numbered", async () => {
    const { api, service } = setup();
    const run = await api.startRun(request);
    await service.settled();

    const events = await firstValueFrom(
      api.events(run.id, 0).pipe(take(2), toArray()),
    );

    expect(events.map((event) => event.type)).toEqual(["agentTurn", "status"]);
    expect(events[1]!.seq).toBeGreaterThan(events[0]!.seq);
  });

  it("sends only this Run's events, and only from now on without `after`", async () => {
    const { api, service, log } = setup([
      () => ({ waitingFor: "designGate" }),
      () => ({ waitingFor: "designGate" }),
    ]);
    const first = await api.startRun(request);
    const second = await api.startRun(request);
    await service.settled();

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

  // A client that lost its connection says the last number it saw.
  it("replays what a reconnecting client missed, then carries on live", async () => {
    const { api, service, log } = setup([() => ({ waitingFor: "designGate" })]);
    const run = await api.startRun(request);
    await service.settled();
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

  it("records a decision, answers with the Run, and advances it again", async () => {
    const { api, service, advanced, decisions } = setup([
      () => ({ waitingFor: "designGate" }),
    ]);
    const run = await api.startRun(request);
    await service.settled();

    api.decideDesign(run.id, [
      { documentKind: "systemDesign", decision: "approve", comments: "" },
    ]);
    await service.settled();

    expect(decisions).toEqual([`design:${run.id}`]);
    expect(advanced).toEqual([run.id, run.id]);
  });

  // Advancing twice at once would run two Steps of one Run in parallel.
  it("advances a Run once at a time, and again for a decision made meanwhile", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { api, service, advanced } = setup([
      async () => {
        await gate;
        return { waitingFor: "escalation" } as RunProgress;
      },
    ]);
    const run = await api.startRun(request);

    api.resolveEscalation(run.id, { choice: "skipSlice" });
    api.resolveEscalation(run.id, { choice: "skipSlice" });
    release();
    await service.settled();

    // The first loop, then exactly one more for the decisions it did not see.
    expect(advanced).toEqual([run.id, run.id]);
  });

  it("turns a decision the Orchestrator refuses into a conflict, advancing nothing", async () => {
    const { api, service, advanced } = setup([
      () => ({ waitingFor: "prGate", pullRequest: null }),
    ]);
    const run = await api.startRun(request);
    await service.settled();

    expect(() => api.decidePullRequest(run.id, { choice: "approve" })).toThrow(
      RunConflictError,
    );
    expect(advanced).toEqual([run.id]);
  });

  it("says so when there is no such Run", () => {
    const { api } = setup();

    expect(() => api.getRun("nope")).toThrow(RunNotFoundError);
    expect(() => api.events("nope")).toThrow(RunNotFoundError);
  });

  it("tells the Run's followers when advancing it threw", async () => {
    const { api, service } = setup([
      () => {
        throw new Error("Token Factory could not be reached.");
      },
    ]);
    const run = await api.startRun(request);
    await service.settled();

    const events = await firstValueFrom(
      api.events(run.id, 0).pipe(take(2), toArray()),
    );

    expect(events[1]).toMatchObject({
      type: "problem",
      problem: expect.stringContaining("Token Factory could not be reached."),
    });
  });

  it("resumes every unfinished Run on start, and advances each", async () => {
    const { service, runs, advanced } = setup();
    const waiting = runs.createRun({
      ...request,
      targetRepo: {
        owner: "local",
        name: "app",
        baseBranch: "main",
        runBranch: "sdlc/run",
      },
      stackProfile: "react-node",
    });

    const resumed = await service.resumeUnfinished();
    await service.settled();

    expect(resumed).toEqual([waiting.id]);
    expect(advanced).toEqual([waiting.id]);
  });

  it("lists every Run, newest first", async () => {
    const { api, service } = setup();
    const first = await api.startRun(request);
    const second = await api.startRun(request);
    await service.settled();

    expect(api.listRuns().map((run) => run.id)).toEqual([second.id, first.id]);
  });
});
