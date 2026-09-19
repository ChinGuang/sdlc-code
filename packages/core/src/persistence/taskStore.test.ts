import { describe, expect, it } from "vitest";
import { SqliteSliceStore } from "./sliceStore.js";
import { SqliteTaskStore, type TaskStore } from "./taskStore.js";
import { databaseWithRun } from "./testDatabase.js";

// Tests depend on the interface; only this factory knows the class.
function setup(): { store: TaskStore; runId: string; sliceId: string } {
  const { runId, options } = databaseWithRun();
  const [slice] = new SqliteSliceStore(options).saveSlices(runId, [
    { title: "Walking Skeleton", isWalkingSkeleton: true },
  ]);
  return { store: new SqliteTaskStore(options), runId, sliceId: slice!.id };
}

describe("SqliteTaskStore tasks", () => {
  it("creates Slice and design Tasks, updates status and counts retries", () => {
    const { store, runId, sliceId } = setup();

    const backend = store.createTask({
      runId,
      sliceId,
      agentRole: "backendCoding",
    });
    const design = store.createTask({
      runId,
      sliceId: null,
      agentRole: "systemDesign",
    });
    store.setTaskStatus(backend.id, "running");
    store.addRetry(backend.id);

    expect(backend).toMatchObject({ status: "pending", retries: 0 });
    expect(store.listTasks(runId)).toMatchObject([
      {
        id: backend.id,
        sliceId,
        agentRole: "backendCoding",
        status: "running",
        retries: 1,
      },
      {
        id: design.id,
        sliceId: null,
        agentRole: "systemDesign",
        status: "pending",
      },
    ]);
  });

  it("throws NotFoundError for an unknown Task", () => {
    const { store } = setup();

    expect(() => store.addRetry("nope")).toThrow(/Task nope not found/);
    expect(() => store.startStep("nope")).toThrow(/Task nope not found/);
  });
});

describe("SqliteTaskStore steps", () => {
  it("records event rows in order and completes with Working Memory", () => {
    const { store, runId, sliceId } = setup();
    const task = store.createTask({
      runId,
      sliceId,
      agentRole: "backendCoding",
    });
    const step = store.startStep(task.id);

    store.appendStepEvent(step.id, "message", {
      role: "assistant",
      content: "hi",
    });
    store.appendStepEvent(step.id, "toolCall", {
      name: "read_file",
      arguments: '{"path":"a"}',
    });
    store.appendStepEvent(step.id, "usage", {
      promptTokens: 10,
      completionTokens: 2,
    });
    const done = store.completeStep(step.id, "Added GET /health; tests pass.");

    expect(
      store.listStepEvents(step.id).map((e) => [e.seq, e.type, e.payload]),
    ).toEqual([
      [1, "message", { role: "assistant", content: "hi" }],
      [2, "toolCall", { name: "read_file", arguments: '{"path":"a"}' }],
      [3, "usage", { promptTokens: 10, completionTokens: 2 }],
    ]);
    expect(done).toMatchObject({
      status: "completed",
      workingMemory: "Added GET /health; tests pass.",
    });
    expect(done.endedAt).not.toBeNull();
  });

  it("allows one running Step per Task", () => {
    const { store, runId, sliceId } = setup();
    const task = store.createTask({ runId, sliceId, agentRole: "testing" });
    const first = store.startStep(task.id);

    expect(() => store.startStep(task.id)).toThrow(
      /already has a running Step/,
    );
    store.discardStep(first.id);
    expect(store.startStep(task.id).status).toBe("running");
  });

  it("refuses events and finishing once a Step has ended", () => {
    const { store, runId, sliceId } = setup();
    const task = store.createTask({ runId, sliceId, agentRole: "testing" });
    const step = store.startStep(task.id);
    store.completeStep(step.id, "done");

    expect(() => store.appendStepEvent(step.id, "message", {})).toThrow(
      /completed, not running/,
    );
    expect(() => store.discardStep(step.id)).toThrow(/completed, not running/);
  });

  it("discards every in-flight Step of a Run on resume, and only those", () => {
    const { store, runId, sliceId } = setup();
    const backend = store.createTask({
      runId,
      sliceId,
      agentRole: "backendCoding",
    });
    const frontend = store.createTask({
      runId,
      sliceId,
      agentRole: "frontendCoding",
    });
    const finished = store.startStep(backend.id);
    store.completeStep(finished.id, "ok");
    const inFlightA = store.startStep(backend.id);
    const inFlightB = store.startStep(frontend.id);

    const discarded = store.discardRunningSteps(runId);

    expect(discarded.map((s) => [s.id, s.status])).toEqual([
      [inFlightA.id, "discarded"],
      [inFlightB.id, "discarded"],
    ]);
    expect(store.listSteps(backend.id).map((s) => s.status)).toEqual([
      "completed",
      "discarded",
    ]);
  });
});
