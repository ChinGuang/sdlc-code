import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NewRun } from "../domain/entities.js";
import { IllegalTransitionError } from "../domain/runLifecycle.js";
import { openDatabase, type Database } from "./database.js";
import { SqliteRunStore, type RunStore } from "./runStore.js";

// Tests depend on the interface; only this factory knows the class.
function makeStore(db: Database = openDatabase(":memory:")): RunStore {
  let id = 0;
  let tick = 0;
  return new SqliteRunStore({
    db,
    newId: () => `id-${++id}`,
    now: () => new Date(Date.UTC(2026, 8, 20, 0, 0, tick++)).toISOString(),
  });
}

const newRun: NewRun = {
  projectRequest: "Build a todo app with auth",
  mode: "gated",
  targetRepo: {
    owner: "ChinGuang",
    name: "sdlc-code-demo-todo",
    baseBranch: "main",
    runBranch: "sdlc/todo-app",
  },
  stackProfile: "react-express",
  tokenBudget: 2_000_000,
};

describe("SqliteRunStore runs", () => {
  it("creates a Run in the designing status and reads it back", () => {
    const store = makeStore();

    const run = store.createRun(newRun);

    expect(run).toEqual({
      id: "id-1",
      ...newRun,
      status: "designing",
      tokensUsed: 0,
      pullRequest: null,
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
    });
    expect(store.getRun("id-1")).toEqual(run);
    expect(store.getRun("missing")).toBeNull();
  });

  it("applies events through the Run lifecycle", () => {
    const store = makeStore();
    const { id } = store.createRun(newRun);

    store.applyEvent(id, { type: "documentsReady" });
    const run = store.applyEvent(id, { type: "designApproved" });

    expect(run.status).toBe("building");
    expect(run.updatedAt > run.createdAt).toBe(true);
  });

  it("rejects an illegal event and leaves the Run unchanged", () => {
    const store = makeStore();
    const { id } = store.createRun(newRun);

    expect(() => store.applyEvent(id, { type: "prApproved" })).toThrow(
      IllegalTransitionError,
    );
    expect(store.getRun(id)?.status).toBe("designing");
  });

  it("uses the Run's own mode", () => {
    const store = makeStore();
    const { id } = store.createRun({ ...newRun, mode: "auto" });

    expect(store.applyEvent(id, { type: "documentsReady" }).status).toBe(
      "building",
    );
  });

  it("lists only unfinished Runs, oldest first", () => {
    const store = makeStore();
    const auto = store.createRun({ ...newRun, mode: "auto" });
    const gated = store.createRun(newRun);
    store.applyEvent(auto.id, { type: "documentsReady" });
    store.applyEvent(auto.id, { type: "limitHit", trigger: "tokenBudget" });

    expect(store.listUnfinishedRuns().map((run) => run.id)).toEqual([gated.id]);
  });

  it("adds token usage and rejects negative or fractional amounts", () => {
    const store = makeStore();
    const { id } = store.createRun(newRun);

    store.addTokensUsed(id, 1200);
    expect(store.addTokensUsed(id, 300).tokensUsed).toBe(1500);
    expect(() => store.addTokensUsed(id, -1)).toThrow(RangeError);
    expect(() => store.addTokensUsed(id, 1.5)).toThrow(RangeError);
  });

  it("records the pull request", () => {
    const store = makeStore();
    const { id } = store.createRun(newRun);

    const run = store.setPullRequest(id, {
      number: 12,
      url: "https://github.com/ChinGuang/sdlc-code-demo-todo/pull/12",
      draft: true,
    });

    expect(run.pullRequest).toEqual({
      number: 12,
      url: "https://github.com/ChinGuang/sdlc-code-demo-todo/pull/12",
      draft: true,
    });
  });

  it("throws NotFoundError for an unknown Run", () => {
    const store = makeStore();

    expect(() => store.applyEvent("nope", { type: "documentsReady" })).toThrow(
      /Run nope not found/,
    );
    expect(() => store.addTokensUsed("nope", 1)).toThrow(/not found/);
    expect(() => store.saveCheckpoint("nope", {})).toThrow(/not found/);
  });
});

describe("SqliteRunStore checkpoints", () => {
  it("returns the latest Checkpoint with its payload intact", () => {
    const store = makeStore();
    const { id } = store.createRun(newRun);
    expect(store.latestCheckpoint(id)).toBeNull();

    store.saveCheckpoint(id, { slice: 1 });
    const latest = store.saveCheckpoint(id, {
      slice: 2,
      workingMemory: { backendCoding: "tried X" },
    });

    expect(store.latestCheckpoint(id)).toEqual(latest);
    expect(latest.payload).toEqual({
      slice: 2,
      workingMemory: { backendCoding: "tried X" },
    });
  });
});

describe("SqliteRunStore survives a restart", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it("reads back Runs and Checkpoints after reopening the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdlc-runs-"));
    dirs.push(dir);
    const path = join(dir, "sdlc-code.db");

    const first = openDatabase(path);
    const store = makeStore(first);
    const { id } = store.createRun(newRun);
    store.applyEvent(id, { type: "documentsReady" });
    store.saveCheckpoint(id, { gate: "design" });
    first.close();

    const second = openDatabase(path);
    const reopened = makeStore(second);
    expect(reopened.listUnfinishedRuns()).toMatchObject([
      { id, status: "awaitingDesignGate" },
    ]);
    expect(reopened.latestCheckpoint(id)?.payload).toEqual({ gate: "design" });
    second.close();
  });
});
