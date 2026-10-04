/**
 * The one promise a Draft PR makes, checked against real git: what is pushed
 * holds every Slice Commit and nothing else (T20, UML diagram 3b). A faked
 * Workspace manager can only show that methods were called in an order; this
 * reads the commits and the files that would reach the Target Repo.
 */
import type { GitHubClient, GitPusher, PullRequest } from "@sdlc-code/clients";
import { REACT_NODE, templateFiles } from "@sdlc-code/stack-profiles";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../persistence/database.js";
import { SqliteRunStore } from "../persistence/runStore.js";
import { SqliteSliceStore } from "../persistence/sliceStore.js";
import { SqliteTaskStore } from "../persistence/taskStore.js";
import {
  GitWorkspaceManager,
  type PassedTestRun,
  type WorkspaceManager,
} from "../workspaces/workspaceManager.js";
import { GitHubRunDelivery, type RunDelivery } from "./runDelivery.js";

// Real git, a real template scaffold and a real Test Run record.
vi.setConfig({ testTimeout: 60_000 });

const RUN_BRANCH = "sdlc/todo";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

const git = (repoDir: string, ...args: string[]): string =>
  execFileSync("git", ["--git-dir", repoDir, ...args], {
    encoding: "utf8",
  }).trim();

/** What a passing Test Run of the merged code hands back. */
const PASSED_TEST_RUN: PassedTestRun = {
  status: "passed",
  result: { profile: REACT_NODE.id, passed: true, steps: [], durationMs: 1 },
  evidence: {
    operationId: "op-1",
    exitCode: 0,
    timedOut: false,
    durationSeconds: 1,
    cost: 0,
    log: "",
    changedFiles: [],
    removedFiles: [],
    withheldFiles: [],
  },
};

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "sdlc-draft-"));
  folders.push(root);
  const repoDir = join(root, "run.git");
  const workspaces: WorkspaceManager = new GitWorkspaceManager({
    repoDir,
    runBranch: RUN_BRANCH,
    workspacesDir: join(root, "workspaces"),
  });
  await workspaces.startRun({
    scaffold: templateFiles(REACT_NODE),
    message: `Scaffold: ${REACT_NODE.name}`,
  });

  const db = openDatabase(":memory:");
  const store = { db };
  const runs = new SqliteRunStore(store);
  const slices = new SqliteSliceStore(store);
  const run = runs.createRun({
    projectRequest: "Build a todo app",
    mode: "auto",
    targetRepo: {
      owner: "ChinGuang",
      name: "sdlc-code-demo-todo",
      baseBranch: "main",
      runBranch: RUN_BRANCH,
    },
    stackProfile: REACT_NODE.id,
    tokenBudget: 1_000_000,
  });
  const [first, second] = slices.saveSlices(run.id, [
    { title: "Walking Skeleton", isWalkingSkeleton: true },
    { title: "Todos", isWalkingSkeleton: false },
  ]);

  const pushed: string[] = [];
  const pusher: GitPusher = {
    // What a push would send: the branch as it is when the push happens.
    push: async () => {
      pushed.push(git(repoDir, "rev-parse", RUN_BRANCH));
    },
  };
  const github = {
    getBranchSha: async () => "base-sha",
    findOpenPullRequest: async () => null,
    openPullRequest: async (): Promise<PullRequest> => ({
      number: 1,
      url: "https://github.com/ChinGuang/sdlc-code-demo-todo/pull/1",
      draft: true,
      branch: RUN_BRANCH,
    }),
  } as unknown as GitHubClient;

  // Tests depend on the interface; only this factory knows the class.
  const delivery: RunDelivery = new GitHubRunDelivery({
    runs,
    slices,
    tasks: new SqliteTaskStore(store),
    workspaces,
    pusher,
    github,
    repoDir,
  });
  return {
    delivery,
    workspaces,
    runs,
    slices,
    run,
    repoDir,
    pushed,
    first: first!,
    second: second!,
  };
}

/** Builds a Slice for real: both sides write a file, it merges and commits. */
async function commitSlice(
  context: Awaited<ReturnType<typeof setup>>,
  sliceId: string,
  file: string,
) {
  const { workspaces } = context;
  const backend = await workspaces.openWorkspace(sliceId, "backend");
  const full = join(backend.dir, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "export const ok = true;\n");
  await workspaces.saveWorkspace(backend, `backend: ${file}`);
  const merged = await workspaces.mergeSlice(sliceId, [backend]);
  if (merged.status !== "merged") throw new Error("the Slice did not merge");
  return workspaces.commitSlice(merged, PASSED_TEST_RUN, `Slice: ${file}`);
}

describe("a Draft PR of a Run that stopped", () => {
  it("pushes the Slice Commits and none of the unfinished Slice's files", async () => {
    const context = await setup();
    context.slices.moveSlice(context.first.id, "building");
    context.slices.moveSlice(context.first.id, "testing");
    const commit = await commitSlice(
      context,
      context.first.id,
      "server/health.ts",
    );
    context.slices.moveSlice(context.first.id, "passed", commit);

    // The second Slice is half-written: saved in its Workspace, never merged.
    context.slices.moveSlice(context.second.id, "building");
    const workspace = await context.workspaces.openWorkspace(
      context.second.id,
      "frontend",
    );
    writeFileSync(
      join(workspace.dir, "src", "HalfWritten.tsx"),
      "export const HalfWritten = () => {\n",
    );
    await context.workspaces.saveWorkspace(workspace, "frontend: half written");

    const outcome = await context.delivery.deliver(context.run.id, {
      ended: "failed",
      openDraftPr: true,
    });

    expect(outcome).toMatchObject({ status: "opened" });
    const [head] = context.pushed;
    expect(head).toBe(commit);
    const files = git(context.repoDir, "ls-tree", "-r", "--name-only", head!);
    expect(files).toContain("server/health.ts");
    expect(files).not.toContain("HalfWritten");
    // The Slice Commit is the only commit the Run added.
    expect(
      git(context.repoDir, "log", "--format=%s", "refs/sdlc-run/start..HEAD"),
    ).toBe("Slice: server/health.ts");
  });

  it("leaves no Workspace behind for the Slice that never finished", async () => {
    const context = await setup();
    context.slices.moveSlice(context.first.id, "building");
    context.slices.moveSlice(context.first.id, "testing");
    context.slices.moveSlice(
      context.first.id,
      "passed",
      await commitSlice(context, context.first.id, "server/health.ts"),
    );
    context.slices.moveSlice(context.second.id, "building");
    await context.workspaces.openWorkspace(context.second.id, "frontend");

    await context.delivery.deliver(context.run.id, {
      ended: "aborted",
      openDraftPr: true,
    });

    expect(
      git(context.repoDir, "for-each-ref", "--format=%(refname)").includes(
        "sdlc-workspace",
      ),
    ).toBe(false);
  });

  it("pushes nothing at all when no Slice was ever committed", async () => {
    const context = await setup();
    context.slices.moveSlice(context.first.id, "building");
    await context.workspaces.openWorkspace(context.first.id, "backend");

    const outcome = await context.delivery.deliver(context.run.id, {
      ended: "failed",
      openDraftPr: true,
    });

    expect(outcome).toEqual({ status: "keptLocal", reason: "noSliceCommit" });
    expect(context.pushed).toEqual([]);
  });
});
