// SPDX-License-Identifier: MPL-2.0
/**
 * Resuming, against a real git repository and a real database: what a Run that
 * was interrupted mid-Step looks like afterwards.
 */
import { REACT_NODE, templateFiles } from "@sdlc-code/stack-profiles";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../persistence/database.js";
import { SqliteRunStore } from "../persistence/runStore.js";
import { SqliteSliceStore } from "../persistence/sliceStore.js";
import { SqliteTaskStore } from "../persistence/taskStore.js";
import { GitWorkspaceManager } from "../workspaces/workspaceManager.js";
import type { WorkspaceManager } from "../workspaces/workspaceManager.js";
import { resumeRun } from "./resumeRun.js";

// Real git and a real template scaffold: slow under a loaded suite, like the
// other tests that boot something.
vi.setConfig({ testTimeout: 60_000 });

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "sdlc-resume-"));
  folders.push(root);
  const db = openDatabase(":memory:");
  const store = { db };
  const runs = new SqliteRunStore(store);
  const tasks = new SqliteTaskStore(store);
  const slices = new SqliteSliceStore(store);
  const workspaces: WorkspaceManager = new GitWorkspaceManager({
    repoDir: join(root, "run.git"),
    runBranch: "sdlc/todo",
    workspacesDir: join(root, "workspaces"),
  });
  await workspaces.startRun({
    scaffold: templateFiles(REACT_NODE),
    message: "Scaffold: React + Node",
  });
  const run = runs.createRun({
    projectRequest: "Build a todo app",
    mode: "auto",
    targetRepo: {
      owner: "local",
      name: "app",
      baseBranch: "main",
      runBranch: "sdlc/todo",
    },
    stackProfile: REACT_NODE.id,
    tokenBudget: 1_000_000,
  });
  return {
    runs,
    tasks,
    slices,
    workspaces,
    run,
    options: { runs, tasks, workspaces },
  };
}

/** A Coding Agent halfway through a Step: a running Step and a dirty worktree. */
async function midStep(context: Awaited<ReturnType<typeof setup>>) {
  const slice = context.slices.saveSlices(context.run.id, [
    { title: "Walking Skeleton", isWalkingSkeleton: true },
  ])[0]!;
  const task = context.tasks.createTask({
    runId: context.run.id,
    sliceId: slice.id,
    agentRole: "backendCoding",
  });
  const step = context.tasks.startStep(task.id);
  const workspace = await context.workspaces.openWorkspace(slice.id, "backend");
  const half = join(workspace.dir, "server/todos.ts");
  mkdirSync(dirname(half), { recursive: true });
  writeFileSync(half, "export const todos = [ // half written\n");
  return { slice, task, step, workspace, half };
}

describe("resumeRun", () => {
  it("discards the Step that was running and the work it left behind", async () => {
    const context = await setup();
    const { step, half } = await midStep(context);
    expect(existsSync(half)).toBe(true);

    const resumed = await resumeRun(context.run.id, context.options);

    expect(resumed.discardedSteps).toBe(1);
    expect(resumed.run.id).toBe(context.run.id);
    expect(existsSync(half)).toBe(false);
    expect(
      context.tasks.listSteps(step.taskId).map((saved) => saved.status),
    ).toEqual(["discarded"]);
  });

  // Run #e29ca700: a restart while the Run waited at an Escalation threw away
  // every Step its agents had finished, and they began the Slice again.
  it("keeps the Steps a Workspace saved, and only what it never saved goes", async () => {
    const context = await setup();
    const { workspace } = await midStep(context);
    const done = join(workspace.dir, "server/events.ts");
    writeFileSync(done, "export const events = [];\n");
    await context.workspaces.saveWorkspace(workspace, "backend: attempt 1");
    const unsaved = join(workspace.dir, "server/bookings.ts");
    writeFileSync(unsaved, "export const bookings = [ // half written\n");

    await resumeRun(context.run.id, context.options);

    expect(readFileSync(done, "utf8")).toBe("export const events = [];\n");
    expect(existsSync(unsaved)).toBe(false);
  });

  it("keeps an escalated Run's code whole: nothing was running", async () => {
    const context = await setup();
    const { workspace, step, half } = await midStep(context);
    await context.workspaces.saveWorkspace(workspace, "backend: attempt 3");
    context.tasks.completeStep(step.id, "Stopped: Token Budget exhausted.");

    const resumed = await resumeRun(context.run.id, context.options);

    expect(resumed.discardedSteps).toBe(0);
    // Saved as the agent left it, half-written or not: the next attempt fixes it.
    expect(readFileSync(half, "utf8")).toBe(
      "export const todos = [ // half written\n",
    );
  });

  it("opens again a Workspace whose folder was deleted while it was stopped", async () => {
    const context = await setup();
    const { workspace } = await midStep(context);
    await context.workspaces.saveWorkspace(workspace, "backend: attempt 1");
    rmSync(workspace.dir, { recursive: true, force: true });

    await resumeRun(context.run.id, context.options);

    const reopened = await context.workspaces.openWorkspace(
      workspace.sliceId,
      "backend",
    );
    expect(existsSync(join(reopened.dir, "server/todos.ts"))).toBe(true);
  });

  it("keeps the Slice Commits the Run already earned", async () => {
    const context = await setup();
    const before = await context.workspaces.lastSliceCommit();
    await midStep(context);

    await resumeRun(context.run.id, context.options);

    expect(await context.workspaces.lastSliceCommit()).toBe(before);
  });

  it("says whether there was a Checkpoint to continue from", async () => {
    const context = await setup();

    expect(
      (await resumeRun(context.run.id, context.options)).hadCheckpoint,
    ).toBe(false);

    context.runs.saveCheckpoint(context.run.id, {
      version: 1,
      revisions: [],
      histories: {},
      hints: {},
    });

    expect(
      (await resumeRun(context.run.id, context.options)).hadCheckpoint,
    ).toBe(true);
  });

  it("changes nothing for a Run that stopped between Steps", async () => {
    const context = await setup();

    const resumed = await resumeRun(context.run.id, context.options);

    expect(resumed.discardedSteps).toBe(0);
  });

  it("refuses a Run that is over", async () => {
    const context = await setup();
    context.runs.applyEvent(context.run.id, { type: "designFailed" });

    await expect(resumeRun(context.run.id, context.options)).rejects.toThrow(
      /failed; there is nothing left to resume/,
    );
  });

  it("refuses a Run it cannot find", async () => {
    const context = await setup();

    await expect(resumeRun("no-such-run", context.options)).rejects.toThrow(
      /No Run no-such-run/,
    );
  });
});
