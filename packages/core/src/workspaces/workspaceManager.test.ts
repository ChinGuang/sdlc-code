// SPDX-License-Identifier: MPL-2.0
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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitWorkspaceManager,
  parseBatch,
  parseWorktrees,
  type PassedTestRun,
  type Workspace,
  type WorkspaceManager,
} from "./workspaceManager.js";

// These tests drive real git (many process spawns per test): 2-4s each alone on
// Windows, and far longer when every Vitest project runs at once. The time is
// real work, so this file alone gets a longer timeout than the 5s default.
vi.setConfig({ testTimeout: 60_000 });

const SCAFFOLD = [
  { path: "package.json", contents: '{ "name": "app" }\n' },
  { path: "server/app.ts", contents: "export const routes = [];\n" },
  { path: "src/App.tsx", contents: "export const App = () => null;\n" },
];

/** What a passing Test Run of the merged code hands back. */
const PASSED: PassedTestRun = {
  status: "passed",
  result: { profile: "react-node", passed: true, steps: [], durationMs: 1 },
  evidence: {
    operationId: "op",
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

  it("never commits a secret file, and does not count it as unsaved", async () => {
    const { manager, repoDir } = await setup();
    const backend = await manager.openWorkspace("slice-1", "backend");
    write(backend, ".env", "NEBIUS_API_KEY=secret-key-123");
    write(backend, "server/todos.ts", "export const todos = [];\n");

    const saved = await manager.saveWorkspace(backend, "Backend: todos");

    expect(git(repoDir, "ls-tree", "-r", "--name-only", saved!)).not.toContain(
      ".env",
    );
    await expect(
      manager.mergeSlice("slice-1", [backend]),
    ).resolves.toMatchObject({ status: "merged" });
  });

  it("resets a Workspace to its last save, keeping the saved work", async () => {
    const { manager } = await setup();
    const backend = await manager.openWorkspace("slice-1", "backend");
    write(backend, "server/todos.ts", "saved");
    await manager.saveWorkspace(backend, "Step 1");
    write(backend, "server/todos.ts", "half-written");
    write(backend, "server/draft.ts", "half-written");

    await manager.resetWorkspace(backend);

    expect(read(backend, "server/todos.ts")).toBe("saved");
    expect(existsSync(join(backend.dir, "server/draft.ts"))).toBe(false);
  });

  it("refuses unsafe Slice ids, so a Workspace stays in its folder", async () => {
    const { manager } = await setup();

    for (const id of ["../escape", "a/b", "", "a b"])
      await expect(manager.openWorkspace(id, "backend")).rejects.toThrow(
        /Refusing Slice id/,
      );
  });
});

describe("GitWorkspaceManager.mergedFiles (T24c)", () => {
  it("reads the Slice's merged code as last tested, and nothing before a merge", async () => {
    const { manager } = await setup();
    const { backend, frontend } = await builtSlice(manager);
    expect(await manager.mergedFiles("slice-1")).toEqual([]);

    const merged = await manager.mergeSlice("slice-1", [backend, frontend]);
    if (merged.status !== "merged") throw new Error("expected a merge");

    expect(await manager.mergedFiles("slice-1")).toEqual(
      await manager.readFiles(merged.commit),
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

  it("merges package.json when both sides add dependencies", async () => {
    const { manager } = await setup();
    const backend = await manager.openWorkspace("slice-1", "backend");
    const frontend = await manager.openWorkspace("slice-1", "frontend");
    const withDependency = (name: string) =>
      `${JSON.stringify({ name: "app", dependencies: { [name]: "^1.0.0" } }, null, 2)}\n`;
    write(backend, "package.json", withDependency("zod"));
    write(frontend, "package.json", withDependency("react-router-dom"));
    await manager.saveWorkspace(backend, "backend");
    await manager.saveWorkspace(frontend, "frontend");

    const outcome = await manager.mergeSlice("slice-1", [backend, frontend]);

    expect(outcome.status).toBe("merged");
    if (outcome.status !== "merged") return;
    const manifest = (await manager.readFiles(outcome.commit)).find(
      (file) => file.path === "package.json",
    )!;
    expect(JSON.parse(manifest.contents).dependencies).toEqual({
      "react-router-dom": "^1.0.0",
      zod: "^1.0.0",
    });
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

    const slice = await manager.commitSlice(merged, PASSED, "Slice 1: Todos");

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

  it("lists the Slice Commits, and none before the first Slice passes", async () => {
    const { manager } = await setup();
    expect(await manager.sliceCommits()).toEqual([]);

    const shas: string[] = [];
    for (const id of ["slice-1", "slice-2"]) {
      const { backend } = await builtSlice(manager, id);
      write(backend, `server/${id}.ts`, id);
      await manager.saveWorkspace(backend, id);
      const merged = await manager.mergeSlice(id, [backend]);
      if (merged.status !== "merged") throw new Error("expected a merge");
      shas.push(await manager.commitSlice(merged, PASSED, id));
    }

    expect(await manager.sliceCommits()).toEqual(shas);
  });

  it("refuses to commit a Slice without a passing Test Run", async () => {
    const { manager } = await setup();
    const { backend } = await builtSlice(manager);
    const merged = await manager.mergeSlice("slice-1", [backend]);
    if (merged.status !== "merged") throw new Error("expected a merge");
    const failed = { ...PASSED, status: "failed" } as unknown as typeof PASSED;

    await expect(
      manager.commitSlice(merged, failed, "Slice 1"),
    ).rejects.toThrow(/no passing Test Run/);
    expect(await manager.sliceCommits()).toEqual([]);
  });

  it("starts the next Slice's Workspaces from the new Slice Commit", async () => {
    const { manager } = await setup();
    const { backend, frontend } = await builtSlice(manager);
    const merged = await manager.mergeSlice("slice-1", [backend, frontend]);
    if (merged.status !== "merged") throw new Error("expected a merge");
    await manager.commitSlice(merged, PASSED, "Slice 1: Todos");

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
    await manager.commitSlice(fresh, PASSED, "Slice 2");

    await expect(manager.commitSlice(stale, PASSED, "Slice 1")).rejects.toThrow(
      /merge it again/,
    );
  });
});

describe("GitWorkspaceManager.runDiff", () => {
  it("is everything the Run changed since it started, and nothing else", async () => {
    const { manager } = await setup();
    const { backend, frontend } = await builtSlice(manager);
    const merged = await manager.mergeSlice("slice-1", [backend, frontend]);
    if (merged.status !== "merged") throw new Error("the Slice did not merge");
    await manager.commitSlice(merged, PASSED, "Slice 1: Todos");

    const diff = await manager.runDiff();

    expect(diff).toContain("+++ b/server/todos.ts");
    expect(diff).toContain("+export const todos = [];");
    expect(diff).toContain("+++ b/src/TodoList.tsx");
    // The scaffold is where the Run started, so it is not a change.
    expect(diff).not.toContain("server/app.ts");
  });

  it("is empty before any Slice has been committed", async () => {
    const { manager } = await setup();
    await builtSlice(manager);

    expect(await manager.runDiff()).toBe("");
  });

  it("cuts a diff that would not fit, on a line, saying how big it was", async () => {
    const { manager } = await setup();
    const backend = await manager.openWorkspace("slice-1", "backend");
    write(
      backend,
      "server/long.ts",
      `${Array.from(
        { length: 400 },
        (_, line) => `export const value${line} = "${line}";`,
      ).join("\n")}\n`,
    );
    await manager.saveWorkspace(backend, "backend: a long file");
    const merged = await manager.mergeSlice("slice-1", [backend]);
    if (merged.status !== "merged") throw new Error("the Slice did not merge");
    await manager.commitSlice(merged, PASSED, "Slice 1: long");

    const cut = await manager.runDiff(2000);

    expect(Buffer.byteLength(cut)).toBeLessThan(2100);
    expect(cut).toMatch(/…\(the diff is \d+ bytes; cut here\)\n$/);
    // Cut on a line boundary: no half line before the note.
    const lines = cut.split("\n");
    expect(lines.at(-3)).toMatch(/^\+export const value\d+ = "\d+";$/);
  });
});

describe("GitWorkspaceManager.resetUnsaved (T24h)", () => {
  it("keeps every saved Step and drops what no Workspace saved", async () => {
    const { manager } = await setup();
    const { backend, frontend } = await builtSlice(manager);
    write(backend, "server/todos.ts", "export const todos = [ // unsaved\n");
    write(frontend, "src/Draft.tsx", "export const Draft = () => null;\n");

    await manager.resetUnsaved();

    expect(read(backend, "server/todos.ts")).toBe("export const todos = [];\n");
    expect(read(frontend, "src/TodoList.tsx")).toBe(
      "export const TodoList = () => null;\n",
    );
    expect(existsSync(join(frontend.dir, "src/Draft.tsx"))).toBe(false);
  });

  it("leaves the run branch where it is", async () => {
    const { manager, scaffold } = await setup();
    const { backend } = await builtSlice(manager);
    write(backend, "server/todos.ts", "unsaved");

    await manager.resetUnsaved();

    expect(await manager.lastSliceCommit()).toBe(scaffold);
  });

  // A folder lost while the Run was stopped must not lose its saved Steps.
  it("checks a lost Workspace folder out again with its saved Steps", async () => {
    const { manager } = await setup();
    const { backend } = await builtSlice(manager);
    rmSync(backend.dir, { recursive: true, force: true });

    await manager.resetUnsaved();
    const again = await manager.openWorkspace("slice-1", "backend");

    expect(read(again, "server/todos.ts")).toBe("export const todos = [];\n");
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
    const slice = await manager.commitSlice(merged, PASSED, "Slice 1");
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
    await manager.commitSlice(merged, PASSED, "Slice 1");

    await manager.resetToSliceCommit(scaffold);

    expect(await manager.lastSliceCommit()).toBe(scaffold);
  });

  it("refuses to reset to before the run started", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdlc-target-"));
    folders.push(root);
    const target = join(root, "target");
    mkdirSync(target);
    git(target, "init", "--quiet", "--initial-branch=main");
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
      "--allow-empty",
      "-m",
      "init",
    );
    const repoDir = join(root, "run.git");
    git(root, "clone", "--quiet", "--bare", target, repoDir);
    const { manager } = await setup({ repoDir, baseRef: "main" });

    await expect(
      manager.resetToSliceCommit(git(repoDir, "rev-parse", "main")),
    ).rejects.toThrow(/not a Slice Commit/);
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

describe("GitWorkspaceManager inside someone else's repository", () => {
  /** A folder inside a git repository the Run must never write to. */
  function outerRepository(): { root: string; head: () => string } {
    const root = mkdtempSync(join(tmpdir(), "sdlc-outer-"));
    folders.push(root);
    git(root, "init", "--quiet", "--initial-branch=main");
    git(
      root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "outer",
    );
    return {
      root,
      head: () =>
        git(root, "for-each-ref", "--format=%(refname) %(objectname)"),
    };
  }

  it("refuses a repoDir that is not a bare repository of its own", async () => {
    const outer = outerRepository();
    const before = outer.head();
    const repoDir = join(outer.root, "not-a-repo");
    mkdirSync(repoDir);
    writeFileSync(join(repoDir, "notes.txt"), "user files");
    const manager: WorkspaceManager = new GitWorkspaceManager({
      repoDir,
      runBranch: "sdlc/run",
      workspacesDir: join(outer.root, "ws"),
    });

    await expect(
      manager.startRun({ scaffold: SCAFFOLD, message: "x" }),
    ).rejects.toThrow(/not a bare git repository/);
    expect(outer.head()).toBe(before);
  });

  it("starts in an empty folder inside another repository without touching it", async () => {
    const outer = outerRepository();
    const before = outer.head();
    const repoDir = join(outer.root, "run.git");
    mkdirSync(repoDir);
    const manager: WorkspaceManager = new GitWorkspaceManager({
      repoDir,
      runBranch: "sdlc/run",
      workspacesDir: join(outer.root, "ws"),
    });

    await manager.startRun({ scaffold: SCAFFOLD, message: "x" });
    const backend = await manager.openWorkspace("slice-1", "backend");
    write(backend, "server/todos.ts", "x");
    await manager.saveWorkspace(backend, "x");

    expect(outer.head()).toBe(before);
  });

  it("replaces a stray Workspace folder instead of committing into the repository around it", async () => {
    const outer = outerRepository();
    const before = outer.head();
    const workspacesDir = join(outer.root, "ws");
    const manager: WorkspaceManager = new GitWorkspaceManager({
      repoDir: join(outer.root, "run.git"),
      runBranch: "sdlc/run",
      workspacesDir,
    });
    await manager.startRun({ scaffold: SCAFFOLD, message: "x" });
    // Left by a crash: a folder with the Workspace's name but no worktree.
    mkdirSync(join(workspacesDir, "slice-1-backend"), { recursive: true });
    writeFileSync(join(workspacesDir, "slice-1-backend", "stray.ts"), "x");

    const backend = await manager.openWorkspace("slice-1", "backend");
    write(backend, "server/todos.ts", "x");
    await manager.saveWorkspace(backend, "x");

    expect(existsSync(join(backend.dir, "stray.ts"))).toBe(false);
    expect(outer.head()).toBe(before);
  });
});

describe("GitWorkspaceManager edge cases", () => {
  it("leaves binary files out of a Test Run's files rather than corrupting them", async () => {
    const { manager } = await setup();
    const frontend = await manager.openWorkspace("slice-1", "frontend");
    writeFileSync(
      join(frontend.dir, "src/logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]),
    );
    const saved = await manager.saveWorkspace(frontend, "logo");

    const paths = (await manager.readFiles(saved!)).map((file) => file.path);

    expect(paths).not.toContain("src/logo.png");
    expect(paths).toContain("src/App.tsx");
  });

  it("refuses to merge a Slice with no Workspaces", async () => {
    const { manager } = await setup();

    await expect(manager.mergeSlice("slice-1", [])).rejects.toThrow(
      /no Workspaces/,
    );
  });

  it("refuses a merge result that is not built on the Slice Commit it names", async () => {
    const { manager, scaffold } = await setup();
    const unrelated = await setup();
    const { backend } = await builtSlice(unrelated.manager);
    const foreign = git(backend.dir, "rev-parse", "HEAD");

    await expect(
      manager.commitSlice(
        {
          status: "merged",
          sliceId: "slice-1",
          commit: foreign,
          base: scaffold,
        },
        PASSED,
        "forged",
      ),
    ).rejects.toThrow();
    expect(await manager.sliceCommits()).toEqual([]);
  });

  it("saves backend and frontend at the same time", async () => {
    const { manager } = await setup();
    const backend = await manager.openWorkspace("slice-1", "backend");
    const frontend = await manager.openWorkspace("slice-1", "frontend");
    write(backend, "server/todos.ts", "b");
    write(frontend, "src/TodoList.tsx", "f");

    const saved = await Promise.all([
      manager.saveWorkspace(backend, "backend"),
      manager.saveWorkspace(frontend, "frontend"),
    ]);

    expect(saved.every((sha) => sha !== null)).toBe(true);
    await expect(
      manager.mergeSlice("slice-1", [backend, frontend]),
    ).resolves.toMatchObject({ status: "merged" });
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

/** The file names in a zip, read from its central directory. */
function zipNames(zip: Buffer): string[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("not a zip");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    names.push(zip.toString("utf8", at + 46, at + 46 + name));
    at += 46 + name + extra + comment;
  }
  return names;
}

describe("GitWorkspaceManager.exportArchive (S3)", () => {
  it("is nothing before a Slice has passed: the template alone is not a result", async () => {
    const { manager } = await setup();

    expect(await manager.exportArchive()).toBeNull();
  });

  it("is the code as of the last Slice Commit, as a zip with no git history", async () => {
    const { manager } = await setup();
    const { backend, frontend } = await builtSlice(manager);
    const merged = await manager.mergeSlice("slice-1", [backend, frontend]);
    if (merged.status !== "merged") throw new Error("the Slice did not merge");
    await manager.commitSlice(merged, PASSED, "Slice 1: Todos");

    const zip = await manager.exportArchive();

    expect(zip).not.toBeNull();
    expect(zip!.subarray(0, 2).toString()).toBe("PK");
    const names = zipNames(zip!);
    // What the Slice built, beside what the template gave it.
    expect(names).toEqual(
      expect.arrayContaining(["server/todos.ts", "src/TodoList.tsx"]),
    );
    expect(names.some((name) => name.startsWith(".git"))).toBe(false);
  });

  it("does not hold a Workspace's unsaved or unmerged work", async () => {
    const { manager } = await setup();
    const { backend, frontend } = await builtSlice(manager);
    const merged = await manager.mergeSlice("slice-1", [backend, frontend]);
    if (merged.status !== "merged") throw new Error("the Slice did not merge");
    await manager.commitSlice(merged, PASSED, "Slice 1: Todos");
    const later = await manager.openWorkspace("slice-2", "backend");
    write(later, "server/unfinished.ts", "export const x = 1;\n");
    await manager.saveWorkspace(later, "Backend: unfinished");

    const names = zipNames((await manager.exportArchive())!);

    expect(names).not.toContain("server/unfinished.ts");
  });
});

describe("GitWorkspaceManager.exportArchive: what the application says about itself (S3)", () => {
  async function committedWith(files: Record<string, string>) {
    const { manager } = await setup();
    const backend = await manager.openWorkspace("slice-1", "backend");
    for (const [path, contents] of Object.entries(files))
      write(backend, path, contents);
    await manager.saveWorkspace(backend, "Backend");
    const merged = await manager.mergeSlice("slice-1", [backend]);
    if (merged.status !== "merged") throw new Error("the Slice did not merge");
    await manager.commitSlice(merged, PASSED, "Slice 1");
    return manager;
  }

  // A generated application's own .gitattributes must not shape what is given.
  it("gives every file, whatever the application's .gitattributes says", async () => {
    const manager = await committedWith({
      ".gitattributes": "* export-ignore\n",
      "server/todos.ts": "export const todos = [];\n",
    });

    const names = zipNames((await manager.exportArchive())!);

    expect(names).toEqual(
      expect.arrayContaining(["server/todos.ts", ".gitattributes"]),
    );
  });

  it("does not expand export-subst placeholders in the application's files", async () => {
    const manager = await committedWith({
      ".gitattributes": "server/id.ts export-subst\n",
      "server/id.ts": 'export const id = "$Format:%H$";\n',
    });

    const zip = (await manager.exportArchive())!;

    expect(zip.includes(Buffer.from("$Format:%H$"))).toBe(true);
  });
});

describe("GitWorkspaceManager.isBehind (S5)", () => {
  async function committed(manager: WorkspaceManager, sliceId: string) {
    const backend = await manager.openWorkspace(sliceId, "backend");
    write(backend, `server/${sliceId}.ts`, `export const id = "${sliceId}";\n`);
    await manager.saveWorkspace(backend, `Backend: ${sliceId}`);
    const merged = await manager.mergeSlice(sliceId, [backend]);
    if (merged.status !== "merged") throw new Error("the Slice did not merge");
    await manager.commitSlice(merged, PASSED, `Slice ${sliceId}`);
  }

  it("is false for a Slice with nothing saved, and for one started at the head", async () => {
    const { manager } = await setup();

    expect(await manager.isBehind("slice-1")).toBe(false);
    await manager.openWorkspace("slice-1", "backend");
    expect(await manager.isBehind("slice-1")).toBe(false);
  });

  it("is true once a Slice built beside this one has committed, and false again after starting over", async () => {
    const { manager } = await setup();
    const waiting = await manager.openWorkspace("slice-2", "backend");
    write(waiting, "server/b.ts", "export const b = 1;\n");
    await manager.saveWorkspace(waiting, "Backend: b");

    await committed(manager, "slice-1");

    expect(await manager.isBehind("slice-2")).toBe(true);
    // Its own commit is not "behind": it started from what it merged onto.
    expect(await manager.isBehind("slice-1")).toBe(false);
    await manager.discardSlice("slice-2");
    expect(await manager.isBehind("slice-2")).toBe(false);
    const again = await manager.openWorkspace("slice-2", "backend");
    expect(await manager.isBehind("slice-2")).toBe(false);
    expect(read(again, "server/slice-1.ts")).toContain("slice-1");
  });

  it("holds for a new manager over the same repository, as after a restart", async () => {
    const { manager, repoDir, root } = await setup();
    const waiting = await manager.openWorkspace("slice-2", "backend");
    write(waiting, "server/b.ts", "export const b = 1;\n");
    await manager.saveWorkspace(waiting, "Backend: b");
    await committed(manager, "slice-1");

    // Tests depend on the interface; only this factory knows the class.
    const restarted: WorkspaceManager = new GitWorkspaceManager({
      repoDir,
      runBranch: "sdlc/todo-app",
      workspacesDir: join(root, "workspaces"),
    });

    expect(await restarted.isBehind("slice-2")).toBe(true);
  });
});
