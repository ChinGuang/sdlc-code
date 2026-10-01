import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NewRun } from "../domain/entities.js";
import { IllegalTransitionError } from "../domain/illegalTransitionError.js";
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
      failure: null,
      openDraftPrOnAbort: null,
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

  it("lists every Run, newest first", () => {
    const store = makeStore();
    const first = store.createRun(newRun);
    const second = store.createRun(newRun);

    expect(store.listRuns().map((run) => run.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it("adds token usage and rejects negative or fractional amounts", () => {
    const store = makeStore();
    const { id } = store.createRun(newRun);

    store.addTokensUsed(id, 1200);
    expect(store.addTokensUsed(id, 300).tokensUsed).toBe(1500);
    expect(() => store.addTokensUsed(id, -1)).toThrow(RangeError);
    expect(() => store.addTokensUsed(id, 1.5)).toThrow(RangeError);
  });

  // A Run that stopped because its budget ran out is resumed, not restarted.
  it("gives a Run more budget, but never less than it has spent", () => {
    const store = makeStore();
    const { id, tokenBudget } = store.createRun(newRun);
    store.addTokensUsed(id, 2000);

    expect(store.setTokenBudget(id, tokenBudget * 2).tokenBudget).toBe(
      tokenBudget * 2,
    );
    expect(() => store.setTokenBudget(id, 1999)).toThrow(
      /already spent 2000 tokens/,
    );
    expect(() => store.setTokenBudget(id, 0)).toThrow(RangeError);
    expect(() => store.setTokenBudget(id, 1.5)).toThrow(RangeError);
    expect(() => store.setTokenBudget("nope", 10)).toThrow(/not found/);
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

  it("records why a Run failed, apart from its Checkpoints", () => {
    const store = makeStore();
    const { id } = store.createRun(newRun);

    const run = store.recordFailure(id, {
      trigger: "loop",
      summary: "The same failure came back after a fix.",
      slice: "Todos",
      reports: [{ step: "unit" }],
    });

    expect(run.failure).toEqual({
      trigger: "loop",
      summary: "The same failure came back after a fix.",
      slice: "Todos",
      reports: [{ step: "unit" }],
    });
    expect(store.latestCheckpoint(id)).toBeNull();
    expect(store.createRun(newRun).failure).toBeNull();
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

describe("SqliteRunStore abort choice (T24g)", () => {
  it("keeps what a person who aborts asked for, and nothing until they do", () => {
    const store = makeStore();
    const run = store.createRun(newRun);
    expect(run.openDraftPrOnAbort).toBeNull();

    expect(store.setOpenDraftPrOnAbort(run.id, false).openDraftPrOnAbort).toBe(
      false,
    );
    expect(store.setOpenDraftPrOnAbort(run.id, true).openDraftPrOnAbort).toBe(
      true,
    );
  });
});

describe("SqliteRunStore failure", () => {
  // A gated Run whose design failed is tried again when a person asks (T24f).
  it("forgets why a Run stopped once a person asks for another try", () => {
    const store = makeStore();
    const run = store.createRun(newRun);
    store.recordFailure(run.id, {
      trigger: "design",
      summary: "No valid design.",
      slice: null,
      reports: [],
    });

    const cleared = store.clearFailure(run.id);

    expect(cleared.failure).toBeNull();
    expect(store.getRun(run.id)!.failure).toBeNull();
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
