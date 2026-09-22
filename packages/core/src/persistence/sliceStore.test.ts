import { describe, expect, it } from "vitest";
import { IllegalTransitionError } from "../domain/illegalTransitionError.js";
import { SqliteSliceStore, type SliceStore } from "./sliceStore.js";
import { databaseWithRun } from "./testDatabase.js";

// Tests depend on the interface; only this factory knows the class.
function setup(): { store: SliceStore; runId: string } {
  const { runId, options } = databaseWithRun();
  return { store: new SqliteSliceStore(options), runId };
}

const plan = [
  { title: "Walking Skeleton", isWalkingSkeleton: true },
  { title: "Auth", isWalkingSkeleton: false },
  { title: "Todos CRUD", isWalkingSkeleton: false },
];

describe("SqliteSliceStore", () => {
  it("saves the Slice Plan in order, all pending", () => {
    const { store, runId } = setup();

    const slices = store.saveSlices(runId, plan);

    expect(
      slices.map((s) => [s.order, s.title, s.isWalkingSkeleton, s.status]),
    ).toEqual([
      [1, "Walking Skeleton", true, "pending"],
      [2, "Auth", false, "pending"],
      [3, "Todos CRUD", false, "pending"],
    ]);
    expect(store.listSlices(runId)).toEqual(slices);
  });

  it("replaces the plan while nothing has started", () => {
    const { store, runId } = setup();
    store.saveSlices(runId, plan);

    const revised = store.saveSlices(runId, plan.slice(0, 2));

    expect(revised.map((s) => s.title)).toEqual(["Walking Skeleton", "Auth"]);
  });

  it("refuses to replace the plan once a Slice has started", () => {
    const { store, runId } = setup();
    const [first] = store.saveSlices(runId, plan);
    store.moveSlice(first!.id, "building");

    expect(() => store.saveSlices(runId, plan)).toThrow(/started building/);
  });

  it("reconciles a revised plan: started Slices stay, the rest follow the plan", () => {
    const { store, runId } = setup();
    const [skeleton] = store.saveSlices(runId, plan);
    store.moveSlice(skeleton!.id, "building");

    const slices = store.reconcileSlices(runId, [
      { title: "Walking Skeleton", isWalkingSkeleton: true },
      { title: "Todos CRUD", isWalkingSkeleton: false },
      { title: "Tags", isWalkingSkeleton: false },
    ]);

    expect(slices.map((s) => [s.order, s.title, s.status])).toEqual([
      [1, "Walking Skeleton", "building"],
      [2, "Todos CRUD", "pending"],
      [3, "Tags", "pending"],
    ]);
    expect(slices[0]!.id).toBe(skeleton!.id);
  });

  it("lets a person skip a Slice that has not started", () => {
    const { store, runId } = setup();
    const [skeleton] = store.saveSlices(runId, plan);

    expect(store.moveSlice(skeleton!.id, "skipped").status).toBe("skipped");
  });

  it("passes a Slice with its Slice Commit", () => {
    const { store, runId } = setup();
    const [first] = store.saveSlices(runId, plan);
    store.moveSlice(first!.id, "building");
    store.moveSlice(first!.id, "testing");

    const passed = store.moveSlice(first!.id, "passed", "abc123");

    expect(passed).toMatchObject({ status: "passed", commitSha: "abc123" });
  });

  it("requires a Slice Commit to pass, and only then", () => {
    const { store, runId } = setup();
    const [first] = store.saveSlices(runId, plan);
    store.moveSlice(first!.id, "building");
    store.moveSlice(first!.id, "testing");

    expect(() => store.moveSlice(first!.id, "passed")).toThrow(
      /Slice Commit SHA/,
    );
    expect(() => store.moveSlice(first!.id, "building", "abc")).toThrow(
      /Slice Commit SHA/,
    );
  });

  it("rejects skipping testing", () => {
    const { store, runId } = setup();
    const [first] = store.saveSlices(runId, plan);
    store.moveSlice(first!.id, "building");

    expect(() => store.moveSlice(first!.id, "passed", "abc")).toThrow(
      IllegalTransitionError,
    );
    expect(store.listSlices(runId)[0]?.status).toBe("building");
  });
});
