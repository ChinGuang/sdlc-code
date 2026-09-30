/**
 * The events a Run's own stores report, over a real database: a status for
 * every move a Run makes, and a Step event for every Step, in order.
 */
import { describe, expect, it } from "vitest";
import { openDatabase } from "../persistence/database.js";
import { SqliteRunStore } from "../persistence/runStore.js";
import { SqliteSliceStore } from "../persistence/sliceStore.js";
import { SqliteTaskStore } from "../persistence/taskStore.js";
import { reportingRunStore, reportingTaskStore } from "./reportingStores.js";
import type { RuntimeEvent } from "./runtimeEvents.js";

function setup() {
  const db = openDatabase(":memory:");
  const store = { db };
  const runs = new SqliteRunStore(store);
  const tasks = new SqliteTaskStore(store);
  const slices = new SqliteSliceStore(store);
  const run = runs.createRun({
    projectRequest: "Build a todo app",
    mode: "auto",
    targetRepo: {
      owner: "local",
      name: "app",
      baseBranch: "main",
      runBranch: "sdlc/run",
    },
    stackProfile: "react-node",
    tokenBudget: 1_000_000,
  });
  const events: RuntimeEvent[] = [];
  const emit = (event: RuntimeEvent) => events.push(event);
  return { runs, tasks, slices, run, events, emit };
}

describe("reportingRunStore", () => {
  // One advance moves a Run through several statuses; a client sees each.
  it("reports every status a Run moves to, in order", () => {
    const { runs, run, events, emit } = setup();
    const reporting = reportingRunStore(runs, emit);

    reporting.applyEvent(run.id, { type: "documentsReady" });
    reporting.applyEvent(run.id, { type: "allSlicesCommitted" });

    expect(events).toEqual([
      { runId: run.id, type: "status", status: "building" },
      { runId: run.id, type: "status", status: "reviewing" },
    ]);
  });

  // A budget bar follows the Run without asking for it.
  it("reports what the Run has spent after each model call", () => {
    const { runs, run, events, emit } = setup();
    const reporting = reportingRunStore(runs, emit);

    reporting.addTokensUsed(run.id, 1200);
    reporting.addTokensUsed(run.id, 300);

    expect(events).toEqual([
      { runId: run.id, type: "tokens", used: 1200, budget: 1_000_000 },
      { runId: run.id, type: "tokens", used: 1500, budget: 1_000_000 },
    ]);
  });

  it("reports nothing for a move the lifecycle refuses", () => {
    const { runs, run, events, emit } = setup();

    expect(() =>
      reportingRunStore(runs, emit).applyEvent(run.id, { type: "prApproved" }),
    ).toThrow();
    expect(events).toEqual([]);
  });

  it("does everything else the store does, unchanged", () => {
    const { runs, run, emit } = setup();

    expect(reportingRunStore(runs, emit).getRun(run.id)).toEqual(
      runs.getRun(run.id),
    );
  });
});

describe("reportingTaskStore", () => {
  // The plan's criterion for the stream: Step events, in order.
  it("reports each Step as it starts and ends, with whose it is", () => {
    const { tasks, slices, run, events, emit } = setup();
    const [slice] = slices.saveSlices(run.id, [
      { title: "Walking Skeleton", isWalkingSkeleton: true },
    ]);
    const reporting = reportingTaskStore(tasks, run.id, emit);
    const task = reporting.createTask({
      runId: run.id,
      sliceId: slice!.id,
      agentRole: "backendCoding",
    });

    const first = reporting.startStep(task.id);
    reporting.completeStep(first.id, "- the route is written");
    const second = reporting.startStep(task.id);
    reporting.discardStep(second.id);

    expect(
      events.map((event) =>
        event.type === "step" ? [event.phase, event.stepId] : event.type,
      ),
    ).toEqual([
      ["started", first.id],
      ["completed", first.id],
      ["started", second.id],
      ["discarded", second.id],
    ]);
    expect(events[0]).toEqual({
      runId: run.id,
      type: "step",
      phase: "started",
      stepId: first.id,
      taskId: task.id,
      role: "backendCoding",
      sliceId: slice!.id,
    });
  });

  it("reports nothing for a Step it could not start", () => {
    const { tasks, run, events, emit } = setup();

    expect(() =>
      reportingTaskStore(tasks, run.id, emit).startStep("no-such-task"),
    ).toThrow();
    expect(events).toEqual([]);
  });
});
