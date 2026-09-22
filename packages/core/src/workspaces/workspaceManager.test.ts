/** Runs against real git in temp folders: merges, conflicts, resets, discards. */
import { execFileSync } from "node:child_process";
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
import { afterEach, describe, expect, it } from "vitest";
import {
  GitWorkspaceManager,
  parseBatch,
  parseWorktrees,
  type Workspace,
  type WorkspaceManager,
} from "./workspaceManager.js";

const SCAFFOLD = [
  { path: "package.json", contents: '{ "name": "app" }\n' },
  { path: "server/app.ts", contents: "export const routes = [];\n" },
  { path: "src/App.tsx", contents: "export const App = () => null;\n" },
];

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function setup(options: { baseRef?: string; repoDir?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sdlc-ws-"));
  folders.push(root);
  const repoDir = options.repoDir ?? join(root, "run.git");
  // Tests depend on the interface; only this factory knows the class.
  const manager: WorkspaceManager = new GitWorkspaceManager({
    repoDir,
    runBranch: "sdlc/todo-app",
    workspacesDir: join(root, "workspaces"),
  });
  const scaffold = await manager.startRun({
    scaffold: SCAFFOLD,
    message: "Scaffold: React + Node",
    baseRef: options.baseRef,
  });
  return { manager, repoDir, root, scaffold };
}

function write(workspace: Workspace, path: string, contents: string): void {
  const file = join(workspace.dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

const read = (workspace: Workspace, path: string): string =>
  readFileSync(join(workspace.dir, path), "utf8");

/** A Slice whose backend and frontend both saved their work. */
async function builtSlice(manager: WorkspaceManager, sliceId = "slice-1") {
  const backend = await manager.openWorkspace(sliceId, "backend");
  const frontend = await manager.openWorkspace(sliceId, "frontend");
  write(backend, "server/todos.ts", "export const todos = [];\n");
  write(frontend, "src/TodoList.tsx", "export const TodoList = () => null;\n");
  await manager.saveWorkspace(backend, "Backend: todos API");
  await manager.saveWorkspace(frontend, "Frontend: todo list");
  return { backend, frontend };
}

describe("GitWorkspaceManager.startRun", () => {
  it("starts the run branch with the template as its first commit", async () => {
    const { manager, scaffold } = await setup();

    expect(await manager.lastSliceCommit()).toBe(scaffold);
    expect(await manager.readFiles(scaffold)).toEqual(SCAFFOLD);
  });

  it("builds on the Target Repo's base branch, so the pull request applies to it", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdlc-target-"));
    folders.push(root);
    const target = join(root, "target");
    mkdirSync(target);
    git(target, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(target, "README.md"), "# Todo\n");
    git(target, "add", "README.md");
    git(
      target,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "init",
    );
    const repoDir = join(root, "run.git");
    git(root, "clone", "--quiet", "--bare", target, repoDir);

    const { manager, scaffold } = await setup({ repoDir, baseRef: "main" });

    expect(git(repoDir, "rev-parse", `${scaffold}^`)).toBe(
      git(repoDir, "rev-parse", "main"),
    );
    expect((await manager.readFiles(scaffold)).map((f) => f.path)).toEqual([
      "README.md",
      "package.json",
      "server/app.ts",
      "src/App.tsx",
    ]);
  });

  it("refuses to start a run branch twice", async () => {
    const { manager } = await setup();

    await expect(
      manager.startRun({ scaffold: SCAFFOLD, message: "again" }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("GitWorkspaceManager Workspaces", () => {
  it("opens a Workspace at the last Slice Commit", async () => {
    const { manager } = await setup();

    const backend = await manager.openWorkspace("slice-1", "backend");

    expect(read(backend, "server/app.ts")).toBe(SCAFFOLD[1]!.contents);
  });

  it("gives backend and frontend separate Workspaces", async () => {
    const { manager } = await setup();

    const backend = await manager.openWorkspace("slice-1", "backend");
    const frontend = await manager.openWorkspace("slice-1", "frontend");
    write(backend, "server/todos.ts", "x");

    expect(backend.dir).not.toBe(frontend.dir);
    expect(existsSync(join(frontend.dir, "server/todos.ts"))).toBe(false);
  });

  it("returns a reopened Workspace as the agent left it", async () => {
    const { manager } = await setup();
    const first = await manager.openWorkspace("slice-1", "backend");
    write(first, "server/todos.ts", "draft");

    const again = await manager.openWorkspace("slice-1", "backend");

    expect(again).toEqual(first);
    expect(read(again, "server/todos.ts")).toBe("draft");
  });

  it("saves what the agent wrote, and reports when nothing changed", async () => {
    const { manager, scaffold } = await setup();
    const backend = await manager.openWorkspace("slice-1", "backend");

    expect(await manager.saveWorkspace(backend, "nothing")).toBeNull();

    write(backend, "server/todos.ts", "export const todos = [];\n");
    const saved = await manager.saveWorkspace(backend, "Backend: todos");

    expect(saved).toMatch(/^[0-9a-f]{40}$/);
    expect(git(backend.dir, "rev-parse", "HEAD^")).toBe(scaffold);
    // Saving is not a Slice Commit.
    expect(await manager.lastSliceCommit()).toBe(scaffold);
  });

  it("refuses unsafe Slice ids, so a Workspace stays in its folder", async () => {
    const { manager } = await setup();

    for (const id of ["../escape", "a/b", "", "a b"])
      await expect(manager.openWorkspace(id, "backend")).rejects.toThrow(
        /Refusing Slice id/,
      );
  });
});

describe("GitWorkspaceManager.mergeSlice", () => {
  it("merges backend and frontend without touching the run branch", async () => {
    const { manager, scaffold } = await setup();
    const { backend, frontend } = await builtSlice(manager);

    const merged = await manager.mergeSlice("slice-1", [backend, frontend]);

    expect(merged).toMatchObject({
      status: "merged",
      sliceId: "slice-1",
      base: scaffold,
    });
    if (merged.status !== "merged") return;
    expect((await manager.readFiles(merged.commit)).map((f) => f.path)).toEqual(
      [
        "package.json",
        "server/app.ts",
        "server/todos.ts",
        "src/App.tsx",
        "src/TodoList.tsx",
      ],
    );
    expect(await manager.lastSliceCommit()).toBe(scaffold);
  });

  it("reports a conflict with the files and the Workspace that conflicted", async () => {
    const { manager } = await setup();
    const backend = await manager.openWorkspace("slice-1", "backend");
    const frontend = await manager.openWorkspace("slice-1", "frontend");
    write(backend, "package.json", '{ "name": "api" }\n');
    write(frontend, "package.json", '{ "name": "web" }\n');
    await manager.saveWorkspace(backend, "backend");
    await manager.saveWorkspace(frontend, "frontend");

    const outcome = await manager.mergeSlice("slice-1", [backend, frontend]);

    expect(outcome).toEqual({
      status: "conflict",
      sliceId: "slice-1",
      role: "frontend",
      files: ["package.json"],
    });
    // The agents' work is untouched, so the owner can fix it and retry.
    expect(read(frontend, "package.json")).toBe('{ "name": "web" }\n');
  });

  it("can merge again after a conflict is fixed", async () => {
    const { manager } = await setup();
    const backend = await manager.openWorkspace("slice-1", "backend");
    const frontend = await manager.openWorkspace("slice-1", "frontend");
    write(backend, "package.json", '{ "name": "api" }\n');
    write(frontend, "package.json", '{ "name": "web" }\n');
    await manager.saveWorkspace(backend, "backend");
    await manager.saveWorkspace(frontend, "frontend");
    await manager.mergeSlice("slice-1", [backend, frontend]);

    // The frontend agent takes the backend's version.
    write(frontend, "package.json", '{ "name": "api" }\n');
    await manager.saveWorkspace(frontend, "frontend: resolve");
    const outcome = await manager.mergeSlice("slice-1", [backend, frontend]);

    expect(outcome.status).toBe("merged");
  });

  it("refuses to merge a Workspace with unsaved changes", async () => {
    const { manager } = await setup();
    const backend = await manager.openWorkspace("slice-1", "backend");
    write(backend, "server/todos.ts", "unsaved");

    await expect(manager.mergeSlice("slice-1", [backend])).rejects.toThrow(
      /unsaved changes/,
    );
  });

  it("refuses a Workspace from another Slice", async () => {
    const { manager } = await setup();
    const other = await manager.openWorkspace("slice-2", "backend");

    await expect(manager.mergeSlice("slice-1", [other])).rejects.toThrow(
      /belongs to Slice slice-2/,
    );
  });
});

describe("GitWorkspaceManager.commitSlice", () => {
  it("adds one Slice Commit with the merged code, and discards the Workspaces", async () => {
    const { manager, repoDir, scaffold } = await setup();
    const { backend, frontend } = await builtSlice(manager);
    const merged = await manager.mergeSlice("slice-1", [backend, frontend]);
    if (merged.status !== "merged") throw new Error("expected a merge");

    const slice = await manager.commitSlice(merged, "Slice 1: Todos");

    expect(await manager.lastSliceCommit()).toBe(slice);
    // Exactly one commit on top of the last one, whatever the merges were.
    expect(git(repoDir, "rev-list", "--parents", "-n", "1", slice)).toBe(
      `${slice} ${scaffold}`,
    );
    expect(git(repoDir, "log", "-1", "--format=%s %an", slice)).toBe(
      "Slice 1: Todos sdlc-code",
    );
    expect(await manager.readFiles(slice)).toEqual(
      await manager.readFiles(merged.commit),
    );
    expect(existsSync(backend.dir)).toBe(false);
    expect(existsSync(frontend.dir)).toBe(false);
  });

  it("starts the next Slice's Workspaces from the new Slice Commit", async () => {
    const { manager } = await setup();
    const { backend, frontend } = await builtSlice(manager);
    const merged = await manager.mergeSlice("slice-1", [backend, frontend]);
    if (merged.status !== "merged") throw new Error("expected a merge");
    await manager.commitSlice(merged, "Slice 1: Todos");

    const next = await manager.openWorkspace("slice-2", "backend");

    expect(read(next, "server/todos.ts")).toBe("export const todos = [];\n");
  });

  it("refuses a merge made onto an older Slice Commit", async () => {
    const { manager } = await setup();
    const first = await builtSlice(manager, "slice-1");
    const stale = await manager.mergeSlice("slice-1", [
      first.backend,
      first.frontend,
    ]);
    const second = await builtSlice(manager, "slice-2");
    const fresh = await manager.mergeSlice("slice-2", [
      second.backend,
      second.frontend,
    ]);
    if (stale.status !== "merged" || fresh.status !== "merged")
      throw new Error("expected merges");
    await manager.commitSlice(fresh, "Slice 2");

    await expect(manager.commitSlice(stale, "Slice 1")).rejects.toThrow(
      /merge it again/,
    );
  });
});

describe("GitWorkspaceManager discard and reset", () => {
  it("discards a Slice's Workspaces, so its next attempt starts clean", async () => {
    const { manager } = await setup();
    const { backend } = await builtSlice(manager);

    await manager.discardSlice("slice-1");

    expect(existsSync(backend.dir)).toBe(false);
    const again = await manager.openWorkspace("slice-1", "backend");
    expect(existsSync(join(again.dir, "server/todos.ts"))).toBe(false);
  });

  it("discards only that Slice, even when another Slice's id starts the same", async () => {
    const { manager } = await setup();
    await builtSlice(manager, "slice-1");
    const other = await builtSlice(manager, "slice-1-x");

    await manager.discardSlice("slice-1");

    expect(read(other.backend, "server/todos.ts")).toBe(
      "export const todos = [];\n",
    );
    await expect(
      manager.mergeSlice("slice-1-x", [other.backend, other.frontend]),
    ).resolves.toMatchObject({ status: "merged" });
  });

  it("discards every unfinished Workspace but keeps the Slice Commits", async () => {
    const { manager, repoDir } = await setup();
    const done = await builtSlice(manager, "slice-1");
    const merged = await manager.mergeSlice("slice-1", [
      done.backend,
      done.frontend,
    ]);
    if (merged.status !== "merged") throw new Error("expected a merge");
    const slice = await manager.commitSlice(merged, "Slice 1");
    const unfinished = await builtSlice(manager, "slice-2");

    await manager.discardUnfinished();

    expect(existsSync(unfinished.backend.dir)).toBe(false);
    expect(await manager.lastSliceCommit()).toBe(slice);
    expect(git(repoDir, "branch", "--list", "sdlc-workspace/*")).toBe("");
  });

  it("replaces a Workspace folder git no longer tracks", async () => {
    const { manager, repoDir } = await setup();
    const { backend } = await builtSlice(manager);
    // As if the process died and the worktree metadata was pruned.
    rmSync(join(repoDir, "worktrees"), { recursive: true, force: true });

    await manager.discardUnfinished();
    const again = await manager.openWorkspace("slice-1", "backend");

    expect(again.dir).toBe(backend.dir);
    expect(existsSync(join(again.dir, "server/todos.ts"))).toBe(false);
    write(again, "server/todos.ts", "retry");
    await expect(manager.saveWorkspace(again, "retry")).resolves.toMatch(
      /^[0-9a-f]{40}$/,
    );
  });

  it("resets the run branch to an earlier Slice Commit", async () => {
    const { manager, scaffold } = await setup();
    const { backend, frontend } = await builtSlice(manager);
    const merged = await manager.mergeSlice("slice-1", [backend, frontend]);
    if (merged.status !== "merged") throw new Error("expected a merge");
    await manager.commitSlice(merged, "Slice 1");

    await manager.resetToSliceCommit(scaffold);

    expect(await manager.lastSliceCommit()).toBe(scaffold);
  });

  it("refuses to reset to a commit that is not on the run branch", async () => {
    const { manager } = await setup();
    const { backend } = await builtSlice(manager);
    const unmerged = git(backend.dir, "rev-parse", "HEAD");

    await expect(manager.resetToSliceCommit(unmerged)).rejects.toThrow(
      /not a Slice Commit/,
    );
  });
});

describe("git output parsing", () => {
  it("reads cat-file batch output by byte size, including multi-byte text", () => {
    const one = Buffer.from("héllo\nworld", "utf8");
    const two = Buffer.from("", "utf8");
    const bytes = Buffer.concat([
      Buffer.from(`aaa blob ${one.length}\n`),
      one,
      Buffer.from("\n"),
      Buffer.from(`bbb blob ${two.length}\n`),
      two,
      Buffer.from("\n"),
    ]);

    expect(parseBatch(bytes)).toEqual(["héllo\nworld", ""]);
  });

  it("reads worktree list records", () => {
    expect(
      parseWorktrees(
        "worktree /r\0bare\0\0worktree /w/a\0HEAD abc\0branch refs/heads/x\0\0",
      ),
    ).toEqual([
      { dir: "/r", branch: null },
      { dir: "/w/a", branch: "refs/heads/x" },
    ]);
  });
});
