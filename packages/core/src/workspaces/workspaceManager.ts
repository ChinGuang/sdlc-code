/**
 * Workspaces (CONTEXT.md, ADR 0001): local git is the source of truth. A Run
 * has one bare repository whose run branch holds only Slice Commits, one
 * commit per Slice that passed testing. Each Coding Agent writes in its own
 * git worktree branched from the last Slice Commit; the Orchestrator merges a
 * Slice's worktrees, and the merge becomes the next Slice Commit only after
 * its Test Run passes.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TemplateFile } from "@sdlc-code/stack-profiles";
import {
  GitError,
  gitSafetyConfig,
  runGitCommand,
  type GitCommand,
  type GitOutput,
} from "./git.js";

/** The Coding Agents that own a Workspace in a Slice. */
export const WORKSPACE_ROLES = ["backend", "frontend"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export type Workspace = {
  sliceId: string;
  role: WorkspaceRole;
  /** The worktree the Coding Agent's file tools are scoped to. */
  dir: string;
  branch: string;
};

export type MergeOutcome =
  | {
      status: "merged";
      sliceId: string;
      /** The merged code, not yet a Slice Commit: Test Run it first. */
      commit: string;
      /** The Slice Commit it was merged onto. */
      base: string;
    }
  | {
      status: "conflict";
      sliceId: string;
      /** The Workspace whose merge conflicted with the ones before it. */
      role: WorkspaceRole;
      files: string[];
    };

export type GitAuthor = { name: string; email: string };

export type WorkspaceManagerOptions = {
  /** The Run's bare repository; created by `startRun` if missing. */
  repoDir: string;
  /** Holds only Slice Commits, and becomes the pull request. */
  runBranch: string;
  /** Where the worktrees live. */
  workspacesDir: string;
  author?: GitAuthor;
  git?: GitCommand;
};

/** A Run's Workspaces and Slice Commits, in local git. */
export interface WorkspaceManager {
  /**
   * Creates the repository if needed and starts the run branch at `baseRef`
   * (the Target Repo's base branch) with the Stack Profile's template added,
   * or with the template alone when there is no base. Returns that commit.
   */
  startRun: (start: {
    scaffold: readonly TemplateFile[];
    message: string;
    baseRef?: string;
  }) => Promise<string>;
  /** The run branch's head: the last Slice Commit (or the scaffold). */
  lastSliceCommit: () => Promise<string>;
  /**
   * The Workspace for one Coding Agent in a Slice. A new one starts at the
   * last Slice Commit; an existing one is returned as the agent left it.
   */
  openWorkspace: (sliceId: string, role: WorkspaceRole) => Promise<Workspace>;
  /** Commits everything the agent wrote; null when nothing changed. */
  saveWorkspace: (
    workspace: Workspace,
    message: string,
  ) => Promise<string | null>;
  /** Merges the Slice's saved Workspaces, in order, onto the last Slice Commit. */
  mergeSlice: (
    sliceId: string,
    workspaces: readonly Workspace[],
  ) => Promise<MergeOutcome>;
  /** The application's files at a commit, for a Test Run. */
  readFiles: (commit: string) => Promise<TemplateFile[]>;
  /**
   * After a passing Test Run: the merged code becomes one Slice Commit on the
   * run branch, and the Slice's worktrees are discarded. Returns its sha.
   */
  commitSlice: (
    merged: Extract<MergeOutcome, { status: "merged" }>,
    message: string,
  ) => Promise<string>;
  /** Discards a Slice's worktrees and branches, so its next attempt starts clean. */
  discardSlice: (sliceId: string) => Promise<void>;
  /** Discards every unfinished worktree, e.g. when a Run resumes. */
  discardUnfinished: () => Promise<void>;
  /**
   * Moves the run branch back to an earlier Slice Commit, e.g. the one the
   * last Checkpoint recorded, and discards every worktree.
   */
  resetToSliceCommit: (commit: string) => Promise<void>;
}

const DEFAULT_AUTHOR: GitAuthor = {
  name: "sdlc-code",
  email: "sdlc-code@users.noreply.github.com",
};

/** Workspace branches live beside the run branch, never under it. */
const WORKSPACE_REFS = "refs/heads/sdlc-workspace/";
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NO_HOOKS_DIR = ".no-hooks";

export class GitWorkspaceManager implements WorkspaceManager {
  #repoDir: string;
  #runBranch: string;
  #workspacesDir: string;
  #author: GitAuthor;
  #git: GitCommand;
  #safety: string[];

  constructor(options: WorkspaceManagerOptions) {
    this.#repoDir = options.repoDir;
    this.#runBranch = options.runBranch;
    this.#workspacesDir = options.workspacesDir;
    this.#author = options.author ?? DEFAULT_AUTHOR;
    this.#git = options.git ?? runGitCommand;
    this.#safety = gitSafetyConfig(join(options.workspacesDir, NO_HOOKS_DIR));
  }

  startRun = async ({
    scaffold,
    message,
    baseRef,
  }: {
    scaffold: readonly TemplateFile[];
    message: string;
    baseRef?: string;
  }): Promise<string> => {
    if (!existsSync(this.#repoDir)) {
      mkdirSync(this.#repoDir, { recursive: true });
      await this.#run(this.#repoDir, [
        "init",
        "--bare",
        "--quiet",
        `--initial-branch=${this.#runBranch}`,
      ]);
    }
    if (await this.#resolve(`refs/heads/${this.#runBranch}`))
      throw new Error(`The run branch ${this.#runBranch} already exists.`);
    const base = baseRef ? await this.#commitOf(baseRef) : null;
    const commit = await this.#commitFiles(scaffold, base, message);
    await this.#run(this.#repoDir, [
      "update-ref",
      `refs/heads/${this.#runBranch}`,
      commit,
      "",
    ]);
    return commit;
  };

  lastSliceCommit = (): Promise<string> =>
    this.#commitOf(`refs/heads/${this.#runBranch}`);

  openWorkspace = async (
    sliceId: string,
    role: WorkspaceRole,
  ): Promise<Workspace> => {
    const workspace = this.#workspace(sliceId, role);
    if (await this.#isWorktree(workspace.dir)) return workspace;
    // A folder git does not know (left by a crash) holds nothing to keep.
    rmSync(workspace.dir, { recursive: true, force: true });
    await this.#addWorktree(workspace.dir, workspace.branch);
    return workspace;
  };

  saveWorkspace = async (
    workspace: Workspace,
    message: string,
  ): Promise<string | null> => {
    const { dir } = this.#workspace(workspace.sliceId, workspace.role);
    await this.#run(dir, ["add", "--all"]);
    const staged = await this.#git(
      [...this.#safety, "diff", "--cached", "--quiet"],
      { cwd: dir },
    );
    if (staged.exitCode === 0) return null;
    await this.#run(dir, ["commit", "--quiet", "--no-verify", "-m", message], {
      env: this.#identity(),
    });
    return this.#commitOf("HEAD", dir);
  };

  mergeSlice = async (
    sliceId: string,
    workspaces: readonly Workspace[],
  ): Promise<MergeOutcome> => {
    for (const workspace of workspaces) {
      if (workspace.sliceId !== sliceId)
        throw new Error(
          `Workspace ${workspace.branch} belongs to Slice ${workspace.sliceId}, not ${sliceId}.`,
        );
      const { dir } = this.#workspace(workspace.sliceId, workspace.role);
      const status = await this.#run(dir, ["status", "--porcelain"]);
      if (status.stdout.trim() !== "")
        throw new Error(
          `The ${workspace.role} Workspace of Slice ${sliceId} has unsaved changes; save it before merging.`,
        );
    }

    const base = await this.lastSliceCommit();
    const merge = this.#workspacePaths(sliceId, "merge");
    if (existsSync(merge.dir)) await this.#removeWorktree(merge.dir);
    await this.#addWorktree(merge.dir, merge.branch, base);

    for (const workspace of workspaces) {
      const merged = await this.#git(
        [
          ...this.#safety,
          "merge",
          "--no-ff",
          "--no-verify",
          "--no-edit",
          "-m",
          `Merge ${workspace.role} of Slice ${sliceId}`,
          this.#workspace(workspace.sliceId, workspace.role).branch,
        ],
        { cwd: merge.dir, env: this.#identity() },
      );
      if (merged.exitCode === 0) continue;
      const conflicted = await this.#run(merge.dir, [
        "diff",
        "--name-only",
        "--diff-filter=U",
        "-z",
      ]);
      const files = conflicted.stdout.split("\0").filter(Boolean);
      if (files.length === 0) throw new GitError(["merge"], merged);
      await this.#run(merge.dir, ["merge", "--abort"]);
      return { status: "conflict", sliceId, role: workspace.role, files };
    }
    return {
      status: "merged",
      sliceId,
      commit: await this.#commitOf("HEAD", merge.dir),
      base,
    };
  };

  readFiles = async (commit: string): Promise<TemplateFile[]> => {
    const tree = await this.#run(this.#repoDir, [
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      await this.#commitOf(commit),
    ]);
    // "<mode> <type> <sha>\t<path>"; symlinks and submodules are not source.
    const blobs = tree.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const tab = entry.indexOf("\t");
        const [mode, type, sha] = entry.slice(0, tab).split(" ");
        return { mode, type, sha: sha!, path: entry.slice(tab + 1) };
      })
      .filter((entry) => entry.type === "blob" && entry.mode !== "120000");
    if (blobs.length === 0) return [];

    const batch = await this.#run(this.#repoDir, ["cat-file", "--batch"], {
      input: blobs.map((blob) => `${blob.sha}\n`).join(""),
    });
    return parseBatch(batch.bytes).map((contents, index) => ({
      path: blobs[index]!.path,
      contents,
    }));
  };

  commitSlice = async (
    merged: Extract<MergeOutcome, { status: "merged" }>,
    message: string,
  ): Promise<string> => {
    const head = await this.lastSliceCommit();
    if (head !== merged.base)
      throw new Error(
        `Slice ${merged.sliceId} was merged onto ${merged.base}, but the last Slice Commit is now ${head}; merge it again.`,
      );
    // One commit per Slice: the pull request reads as the Slice plan.
    const commit = await this.#run(
      this.#repoDir,
      ["commit-tree", `${merged.commit}^{tree}`, "-p", head, "-m", message],
      { env: this.#identity() },
    );
    const sha = commit.stdout.trim();
    await this.#run(this.#repoDir, [
      "update-ref",
      `refs/heads/${this.#runBranch}`,
      sha,
      head,
    ]);
    await this.discardSlice(merged.sliceId);
    return sha;
  };

  discardSlice = async (sliceId: string): Promise<void> => {
    assertSafeId(sliceId);
    const folders = [...WORKSPACE_ROLES, "merge"].map(
      (name) => `${sliceId}-${name}`,
    );
    await this.#discard(`${WORKSPACE_REFS}${sliceId}/`, (entry) =>
      folders.includes(entry),
    );
  };

  discardUnfinished = (): Promise<void> =>
    this.#discard(WORKSPACE_REFS, (entry) => entry !== NO_HOOKS_DIR);

  resetToSliceCommit = async (commit: string): Promise<void> => {
    const target = await this.#commitOf(commit);
    const head = await this.lastSliceCommit();
    const ancestor = await this.#git(
      [...this.#safety, "merge-base", "--is-ancestor", target, head],
      { cwd: this.#repoDir },
    );
    if (ancestor.exitCode !== 0)
      throw new Error(
        `${commit} is not a Slice Commit of ${this.#runBranch}; refusing to move the run branch to it.`,
      );
    await this.discardUnfinished();
    await this.#run(this.#repoDir, [
      "update-ref",
      `refs/heads/${this.#runBranch}`,
      target,
      head,
    ]);
  };

  #workspace(sliceId: string, role: WorkspaceRole): Workspace {
    if (!WORKSPACE_ROLES.includes(role))
      throw new Error(`Unknown Workspace role "${role}".`);
    return { sliceId, role, ...this.#workspacePaths(sliceId, role) };
  }

  #workspacePaths(
    sliceId: string,
    name: string,
  ): { dir: string; branch: string } {
    assertSafeId(sliceId);
    return {
      dir: join(this.#workspacesDir, `${sliceId}-${name}`),
      branch: `${WORKSPACE_REFS.slice("refs/heads/".length)}${sliceId}/${name}`,
    };
  }

  async #addWorktree(dir: string, branch: string, from?: string) {
    mkdirSync(this.#workspacesDir, { recursive: true });
    await this.#run(this.#repoDir, [
      "worktree",
      "add",
      "--quiet",
      "-B",
      branch,
      dir,
      from ?? (await this.lastSliceCommit()),
    ]);
  }

  async #removeWorktree(dir: string) {
    await this.#git([...this.#safety, "worktree", "remove", "--force", dir], {
      cwd: this.#repoDir,
    });
    // A worktree git no longer knows (e.g. after a crash) is only a folder.
    rmSync(dir, { recursive: true, force: true });
  }

  /**
   * Removes the worktrees on branches under `prefix`, then the branches, then
   * the folders `isStale` names that git had lost track of.
   */
  async #discard(prefix: string, isStale: (folder: string) => boolean) {
    const list = await this.#run(this.#repoDir, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const worktrees = parseWorktrees(list.stdout).filter((worktree) =>
      worktree.branch?.startsWith(prefix),
    );
    for (const worktree of worktrees) await this.#removeWorktree(worktree.dir);
    await this.#run(this.#repoDir, ["worktree", "prune"]);
    const refs = await this.#run(this.#repoDir, [
      "for-each-ref",
      "--format=%(refname)",
      prefix,
    ]);
    const input = refs.stdout
      .split("\n")
      .filter(Boolean)
      .map((ref) => `delete ${ref}\n`)
      .join("");
    if (input)
      await this.#run(this.#repoDir, ["update-ref", "--stdin"], { input });
    if (!existsSync(this.#workspacesDir)) return;
    for (const entry of readdirSync(this.#workspacesDir))
      if (isStale(entry))
        rmSync(join(this.#workspacesDir, entry), {
          recursive: true,
          force: true,
        });
  }

  async #isWorktree(dir: string): Promise<boolean> {
    if (!existsSync(dir)) return false;
    const top = await this.#git(
      [...this.#safety, "rev-parse", "--is-inside-work-tree"],
      { cwd: dir },
    );
    return top.exitCode === 0 && top.stdout.trim() === "true";
  }

  /** A commit of exactly these files on top of `parent`'s tree. */
  async #commitFiles(
    files: readonly TemplateFile[],
    parent: string | null,
    message: string,
  ): Promise<string> {
    const index = join(tmpdir(), `sdlc-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      if (parent)
        await this.#run(this.#repoDir, ["read-tree", parent], { env });
      const entries: string[] = [];
      for (const file of files) {
        const blob = await this.#run(
          this.#repoDir,
          ["hash-object", "-w", "--stdin"],
          { input: file.contents },
        );
        entries.push(`100644 ${blob.stdout.trim()}\t${file.path}\n`);
      }
      await this.#run(
        this.#repoDir,
        ["update-index", "--add", "--index-info"],
        {
          env,
          input: entries.join(""),
        },
      );
      const tree = await this.#run(this.#repoDir, ["write-tree"], { env });
      const commit = await this.#run(
        this.#repoDir,
        [
          "commit-tree",
          tree.stdout.trim(),
          ...(parent ? ["-p", parent] : []),
          "-m",
          message,
        ],
        { env: this.#identity() },
      );
      return commit.stdout.trim();
    } finally {
      rmSync(index, { force: true });
    }
  }

  async #resolve(ref: string, cwd = this.#repoDir): Promise<string | null> {
    const resolved = await this.#git(
      [...this.#safety, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { cwd },
    );
    return resolved.exitCode === 0 ? resolved.stdout.trim() : null;
  }

  async #commitOf(ref: string, cwd = this.#repoDir): Promise<string> {
    const sha = await this.#resolve(ref, cwd);
    if (!sha) throw new Error(`No commit named ${ref}.`);
    return sha;
  }

  #identity(): Record<string, string> {
    return {
      GIT_AUTHOR_NAME: this.#author.name,
      GIT_AUTHOR_EMAIL: this.#author.email,
      GIT_COMMITTER_NAME: this.#author.name,
      GIT_COMMITTER_EMAIL: this.#author.email,
    };
  }

  async #run(
    cwd: string,
    args: readonly string[],
    options: { input?: string; env?: Record<string, string> } = {},
  ): Promise<GitOutput> {
    const all = [...this.#safety, ...args];
    const output = await this.#git(all, { cwd, ...options });
    if (output.exitCode !== 0) throw new GitError(args, output);
    return output;
  }
}

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id))
    throw new Error(
      `Refusing Slice id "${id}": use letters, digits, "-" and "_" only.`,
    );
}

/** `git worktree list --porcelain -z`: records separated by an empty field. */
export function parseWorktrees(
  output: string,
): Array<{ dir: string; branch: string | null }> {
  const worktrees: Array<{ dir: string; branch: string | null }> = [];
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree "))
      worktrees.push({ dir: field.slice("worktree ".length), branch: null });
    else if (field.startsWith("branch ") && worktrees.length > 0)
      worktrees.at(-1)!.branch = field.slice("branch ".length);
  }
  return worktrees;
}

/** `git cat-file --batch` output: "<sha> <type> <size>\n<bytes>\n" per object. */
export function parseBatch(bytes: Buffer): string[] {
  const contents: string[] = [];
  let at = 0;
  while (at < bytes.length) {
    const newline = bytes.indexOf(0x0a, at);
    const header = bytes.subarray(at, newline).toString("utf8");
    const size = Number(header.split(" ")[2]);
    if (!Number.isInteger(size))
      throw new Error(`Unexpected git cat-file output: ${header}`);
    const start = newline + 1;
    contents.push(bytes.subarray(start, start + size).toString("utf8"));
    at = start + size + 1;
  }
  return contents;
}
