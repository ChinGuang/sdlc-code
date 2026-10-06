// SPDX-License-Identifier: MPL-2.0
/**
 * Workspaces (CONTEXT.md, ADR 0001): local git is the source of truth. A Run
 * has one bare repository whose run branch holds only Slice Commits, one
 * commit per Slice that passed testing. Each Coding Agent writes in its own
 * git worktree branched from the last Slice Commit; the Orchestrator merges a
 * Slice's worktrees, and the merge becomes the next Slice Commit only after
 * its Test Run passes.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import type { TemplateFile } from "@sdlc-code/stack-profiles";
import { isSecretFile } from "../testRuns/sandboxFiles.js";
import type { TestRunOutcome } from "../testRuns/testRunner.js";
import {
  GitError,
  gitSafetyConfig,
  runGitCommand,
  type GitCommand,
  type GitOutput,
} from "./git.js";
import { mergePackageJson } from "./packageJsonMerge.js";

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

/** Only a passing Test Run lets merged code become a Slice Commit. */
export type PassedTestRun = TestRunOutcome & { status: "passed" };

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
   * with the Stack Profile's template added, or with the template alone when
   * there is no base. Returns that start commit.
   *
   * For a pull request, `repoDir` must already be a bare clone of the Target
   * Repo (fetching it needs the Target Repo's credentials, which stay in the
   * GitHub client) and `baseRef` its base branch.
   */
  startRun: (start: {
    scaffold: readonly TemplateFile[];
    message: string;
    baseRef?: string;
  }) => Promise<string>;
  /** The run branch's head: the last Slice Commit, or the start commit. */
  lastSliceCommit: () => Promise<string>;
  /**
   * The Slice Commits so far, oldest first; empty when no Slice has passed,
   * so there is nothing to deliver.
   */
  sliceCommits: () => Promise<string[]>;
  /**
   * The code as of the last Slice Commit, as a zip (S3): the files of the
   * application, with no git history. Null when no Slice has passed, so there
   * is nothing but the template to give.
   */
  exportArchive: () => Promise<Buffer | null>;
  /**
   * The Workspace for one Coding Agent in a Slice. A new one starts at the
   * last Slice Commit; an existing one is returned as the agent left it.
   */
  openWorkspace: (sliceId: string, role: WorkspaceRole) => Promise<Workspace>;
  /**
   * Commits everything the agent wrote, except secret files; null when
   * nothing changed. A saved Workspace is a completed Step.
   */
  saveWorkspace: (
    workspace: Workspace,
    message: string,
  ) => Promise<string | null>;
  /**
   * Throws away what the agent wrote since its last save: an interrupted
   * Step is redone, and the Workspace's completed Steps are kept.
   */
  resetWorkspace: (workspace: Workspace) => Promise<void>;
  /** Merges the Slice's saved Workspaces, in order, onto the last Slice Commit. */
  mergeSlice: (
    sliceId: string,
    workspaces: readonly Workspace[],
  ) => Promise<MergeOutcome>;
  /** The application's files at a commit, for a Test Run. Text files only. */
  readFiles: (commit: string) => Promise<TemplateFile[]>;
  /**
   * The Slice's merged code as it was last tested, for an Escalation's brief
   * (T24c); empty when the Slice never merged.
   */
  mergedFiles: (sliceId: string) => Promise<TemplateFile[]>;
  /**
   * Everything the Run has changed since it started, as a unified diff, for the
   * Code Review Agent (T19). Cut at `maxBytes` with a line saying so, because a
   * diff has to fit in a model's context.
   */
  runDiff: (maxBytes?: number) => Promise<string>;
  /**
   * After a passing Test Run of the merged code: it becomes one Slice Commit
   * on the run branch, and the Slice's worktrees are discarded. Returns its
   * sha, for the Slice's record (SliceStore.moveSlice to "passed").
   */
  commitSlice: (
    merged: Extract<MergeOutcome, { status: "merged" }>,
    testRun: PassedTestRun,
    message: string,
  ) => Promise<string>;
  /** Discards a Slice's worktrees and branches, so its next attempt starts clean. */
  discardSlice: (sliceId: string) => Promise<void>;
  /**
   * Whether the Slice's saved work was started before the last Slice Commit: a
   * Slice built beside this one committed since, and its work is not in this
   * one (S5). Read from git, so it holds after a restart.
   */
  isBehind: (sliceId: string) => Promise<boolean>;
  /** Discards every unfinished worktree, e.g. when a Run stops early. */
  discardUnfinished: () => Promise<void>;
  /**
   * Throws away what no Workspace saved: an interrupted Step's writes, a
   * merge cut short. Every saved Step is kept, so a resumed Run goes on from
   * the code its agents finished (T24h).
   */
  resetUnsaved: () => Promise<void>;
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

/** The most code an export buffers: a zip of it is built and sent from memory. */
const MAX_EXPORT_BYTES = 200_000_000;

/** The code is too big to give as one download; the Run's repository is the way. */
export class ExportTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportTooLargeError";
  }
}

/** Workspace branches live beside the run branch, never under it. */
const WORKSPACE_REFS = "refs/heads/sdlc-workspace/";
/**
 * Where the run branch started, so Slice Commits can be told apart: the
 * template, on the Target Repo's base branch if it has one.
 */
export const START_REF = "refs/sdlc-run/start";
/** As much diff as a review can read; Nemotron Ultra has room for far more. */
const DEFAULT_DIFF_BYTES = 200_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NO_HOOKS_DIR = ".no-hooks";
const WORKSPACE_FOLDER = /^[A-Za-z0-9_-]{1,64}-(backend|frontend|merge)$/;

export class GitWorkspaceManager implements WorkspaceManager {
  #repoDir: string;
  #runBranch: string;
  #workspacesDir: string;
  #author: GitAuthor;
  #git: GitCommand;
  #safety: string[];
  #ceilings: string;

  constructor(options: WorkspaceManagerOptions) {
    this.#repoDir = options.repoDir;
    this.#runBranch = options.runBranch;
    this.#workspacesDir = options.workspacesDir;
    this.#author = options.author ?? DEFAULT_AUTHOR;
    this.#git = options.git ?? runGitCommand;
    this.#safety = gitSafetyConfig(join(options.workspacesDir, NO_HOOKS_DIR));
    this.#ceilings = [
      dirname(resolve(options.repoDir)),
      resolve(options.workspacesDir),
    ].join(delimiter);
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
    if (!existsSync(this.#repoDir) || readdirSync(this.#repoDir).length === 0) {
      mkdirSync(this.#repoDir, { recursive: true });
      await this.#run(this.#repoDir, [
        "init",
        "--bare",
        "--quiet",
        `--initial-branch=${this.#runBranch}`,
      ]);
    }
    const bare = await this.#exec(this.#repoDir, [
      "rev-parse",
      "--is-bare-repository",
    ]);
    if (bare.exitCode !== 0 || bare.stdout.trim() !== "true")
      throw new Error(
        `${this.#repoDir} is not a bare git repository; a Run needs one of its own.`,
      );
    if (await this.#resolve(`refs/heads/${this.#runBranch}`))
      throw new Error(`The run branch ${this.#runBranch} already exists.`);
    const base = baseRef ? await this.#commitOf(baseRef) : null;
    const commit = await this.#commitFiles(scaffold, base, message);
    await this.#run(this.#repoDir, ["update-ref", "--stdin"], {
      input: `start\ncreate refs/heads/${this.#runBranch} ${commit}\nupdate ${START_REF} ${commit}\ncommit\n`,
    });
    return commit;
  };

  lastSliceCommit = (): Promise<string> =>
    this.#commitOf(`refs/heads/${this.#runBranch}`);

  sliceCommits = async (): Promise<string[]> => {
    const commits = await this.#run(this.#repoDir, [
      "rev-list",
      "--reverse",
      "--first-parent",
      `${await this.#commitOf(START_REF)}..${await this.lastSliceCommit()}`,
    ]);
    return commits.stdout.split("\n").filter(Boolean);
  };

  exportArchive = async (): Promise<Buffer | null> => {
    if ((await this.sliceCommits()).length === 0) return null;
    const commit = await this.lastSliceCommit();
    // The archive is held whole in memory, so an application of more than a
    // few hundred MB is for git to give, not for this to buffer.
    const listing = await this.#run(this.#repoDir, [
      "ls-tree",
      "-r",
      "-l",
      commit,
    ]);
    const bytes = listing.stdout
      .split("\n")
      .reduce((total, line) => total + (Number(line.split(/\s+/)[3]) || 0), 0);
    if (bytes > MAX_EXPORT_BYTES)
      throw new ExportTooLargeError(
        `The code is ${Math.round(bytes / 1e6)} MB, over the ${MAX_EXPORT_BYTES / 1e6} MB an export holds in memory: clone the Run's repository (${this.#repoDir}) instead.`,
      );
    // What the generated application's own .gitattributes says (export-ignore,
    // export-subst) must not change what is given: info/attributes outranks it.
    const info = join(this.#repoDir, "info");
    mkdirSync(info, { recursive: true });
    writeFileSync(join(info, "attributes"), "* -export-ignore -export-subst\n");
    const archive = await this.#run(this.#repoDir, [
      "archive",
      "--format=zip",
      commit,
    ]);
    return archive.bytes;
  };

  openWorkspace = async (
    sliceId: string,
    role: WorkspaceRole,
  ): Promise<Workspace> => {
    const workspace = this.#workspace(sliceId, role);
    if (await this.#isWorktree(workspace.dir)) return workspace;
    // A folder git does not know (left by a crash) holds nothing to keep.
    rmSync(workspace.dir, { recursive: true, force: true });
    // Its branch does: the saved Steps of a Workspace whose folder was lost
    // are checked out again, not reset to the last Slice Commit (T24h).
    const saved = await this.#resolve(`refs/heads/${workspace.branch}`);
    if (saved) await this.#prune();
    await this.#addWorktree(
      workspace.dir,
      workspace.branch,
      saved ?? undefined,
    );
    return workspace;
  };

  saveWorkspace = async (
    workspace: Workspace,
    message: string,
  ): Promise<string | null> => {
    const { dir } = this.#workspace(workspace.sliceId, workspace.role);
    await this.#run(dir, ["add", "--all"]);
    // A secret never reaches the Slice Commit, and so never the pull request.
    const added = await this.#run(dir, [
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=A",
      "-z",
    ]);
    const secrets = added.stdout.split("\0").filter(isSecretFile);
    if (secrets.length > 0)
      await this.#run(dir, ["rm", "--cached", "--quiet", "--", ...secrets]);
    const staged = await this.#exec(dir, ["diff", "--cached", "--quiet"]);
    if (staged.exitCode === 0) return null;
    await this.#run(dir, ["commit", "--quiet", "--no-verify", "-m", message], {
      env: this.#identity(),
    });
    return this.#commitOf("HEAD", dir);
  };

  resetWorkspace = async (workspace: Workspace): Promise<void> => {
    await this.#resetToSave(
      this.#workspace(workspace.sliceId, workspace.role).dir,
    );
  };

  mergeSlice = async (
    sliceId: string,
    workspaces: readonly Workspace[],
  ): Promise<MergeOutcome> => {
    if (workspaces.length === 0)
      throw new Error(`Slice ${sliceId} has no Workspaces to merge.`);
    for (const workspace of workspaces) {
      if (workspace.sliceId !== sliceId)
        throw new Error(
          `Workspace ${workspace.branch} belongs to Slice ${workspace.sliceId}, not ${sliceId}.`,
        );
      const { dir } = this.#workspace(workspace.sliceId, workspace.role);
      // "XY path" records; secret files stay untracked on purpose.
      const status = await this.#run(dir, ["status", "--porcelain", "-z"]);
      const unsaved = status.stdout
        .split("\0")
        .filter(Boolean)
        .filter((record) => !isSecretFile(record.slice(3)));
      if (unsaved.length > 0)
        throw new Error(
          `The ${workspace.role} Workspace of Slice ${sliceId} has unsaved changes; save it before merging.`,
        );
    }

    const base = await this.lastSliceCommit();
    const merge = this.#workspacePaths(sliceId, "merge");
    if (existsSync(merge.dir)) await this.#removeWorktree(merge.dir);
    await this.#addWorktree(merge.dir, merge.branch, base);

    for (const workspace of workspaces) {
      const merged = await this.#exec(
        merge.dir,
        [
          "merge",
          "--no-ff",
          "--no-verify",
          "--no-edit",
          "-m",
          `Merge ${workspace.role} of Slice ${sliceId}`,
          this.#workspace(workspace.sliceId, workspace.role).branch,
        ],
        { env: this.#identity() },
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
      if (
        files.length === 1 &&
        files[0] === "package.json" &&
        (await this.#mergeManifest(merge.dir))
      )
        continue;
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

  runDiff = async (maxBytes = DEFAULT_DIFF_BYTES): Promise<string> => {
    const diff = await this.#run(this.#repoDir, [
      "diff",
      // Function context in the hunk headers, so a reviewer can see where it is.
      "--unified=5",
      "--no-color",
      // Pinned: the review reads paths from the headers, whatever git is set to.
      "--src-prefix=a/",
      "--dst-prefix=b/",
      `${await this.#commitOf(START_REF)}..${await this.lastSliceCommit()}`,
    ]);
    const bytes = Buffer.from(diff.stdout, "utf8");
    if (bytes.byteLength <= maxBytes) return diff.stdout;
    // Cut the bytes, then the partial line, and any half-written character the
    // cut left behind (toString turns those into U+FFFD).
    const kept = bytes.subarray(0, maxBytes).toString("utf8");
    const whole = kept.slice(0, kept.lastIndexOf("\n") + 1).replace(/�/g, "");
    return `${whole}…(the diff is ${bytes.byteLength} bytes; cut here)\n`;
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
    return parseBatch(batch.bytes).flatMap((contents, index) =>
      contents === null ? [] : [{ path: blobs[index]!.path, contents }],
    );
  };

  mergedFiles = async (sliceId: string): Promise<TemplateFile[]> => {
    const { branch } = this.#workspacePaths(sliceId, "merge");
    const merged = await this.#resolve(`refs/heads/${branch}`);
    return merged ? this.readFiles(merged) : [];
  };

  commitSlice = async (
    merged: Extract<MergeOutcome, { status: "merged" }>,
    testRun: PassedTestRun,
    message: string,
  ): Promise<string> => {
    // The type already says so; this holds for callers that cast.
    if ((testRun as TestRunOutcome).status !== "passed")
      throw new Error(
        `Slice ${merged.sliceId} has no passing Test Run; it cannot become a Slice Commit.`,
      );
    const head = await this.lastSliceCommit();
    const mergedCommit = await this.#commitOf(merged.commit);
    const onBase = await this.#exec(this.#repoDir, [
      "merge-base",
      "--is-ancestor",
      merged.base,
      mergedCommit,
    ]);
    if (onBase.exitCode !== 0)
      throw new Error(
        `${merged.commit} is not a merge of Slice ${merged.sliceId} onto ${merged.base}.`,
      );
    if (head !== merged.base)
      throw new Error(
        `Slice ${merged.sliceId} was merged onto ${merged.base}, but the last Slice Commit is now ${head}; merge it again.`,
      );
    // One commit per Slice: the pull request reads as the Slice plan.
    const commit = await this.#run(
      this.#repoDir,
      ["commit-tree", `${mergedCommit}^{tree}`, "-p", head, "-m", message],
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

  isBehind = async (sliceId: string): Promise<boolean> => {
    assertSafeId(sliceId);
    const head = await this.lastSliceCommit();
    for (const role of WORKSPACE_ROLES) {
      const { branch } = this.#workspacePaths(sliceId, role);
      if (!(await this.#resolve(`refs/heads/${branch}`))) continue;
      // The head is in the branch's history only if the branch started from it.
      const contains = await this.#exec(this.#repoDir, [
        "merge-base",
        "--is-ancestor",
        head,
        `refs/heads/${branch}`,
      ]);
      if (contains.exitCode !== 0) return true;
    }
    return false;
  };

  discardUnfinished = (): Promise<void> =>
    this.#discard(WORKSPACE_REFS, (entry) => WORKSPACE_FOLDER.test(entry));

  resetUnsaved = async (): Promise<void> => {
    await this.#prune();
    const list = await this.#run(this.#repoDir, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    for (const { dir, branch } of parseWorktrees(list.stdout))
      if (branch?.startsWith(WORKSPACE_REFS) && existsSync(dir))
        await this.#resetToSave(dir);
  };

  resetToSliceCommit = async (commit: string): Promise<void> => {
    const target = await this.#commitOf(commit);
    const head = await this.lastSliceCommit();
    // On the run branch, and not before its start commit (the Target Repo's).
    const allowed = [
      await this.#commitOf(START_REF),
      ...(await this.sliceCommits()),
    ];
    if (!allowed.includes(target))
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

  /** Throws away what a worktree holds past its last save. */
  async #resetToSave(dir: string) {
    await this.#run(dir, ["reset", "--hard", "--quiet", "HEAD"]);
    await this.#run(dir, ["clean", "-d", "--force", "-x", "--quiet"]);
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

  /**
   * Forgets worktrees whose folder is gone, or checking their branch out
   * again fails with "already checked out".
   */
  async #prune() {
    await this.#run(this.#repoDir, ["worktree", "prune"]);
  }

  async #removeWorktree(dir: string) {
    await this.#exec(this.#repoDir, ["worktree", "remove", "--force", dir]);
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
    await this.#prune();
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

  /**
   * Both sides added to package.json: merge it by key and finish the merge.
   * False when they changed the same key differently, a real conflict.
   */
  async #mergeManifest(dir: string): Promise<boolean> {
    // Index stages of the conflicted file: 1 base, 2 ours, 3 theirs.
    const stage = async (n: number): Promise<string> =>
      (await this.#exec(dir, ["show", `:${n}:package.json`])).stdout;
    const merged = mergePackageJson(
      await stage(1),
      await stage(2),
      await stage(3),
    );
    if (merged === null) return false;
    writeFileSync(join(dir, "package.json"), merged);
    await this.#run(dir, ["add", "package.json"]);
    await this.#run(dir, ["commit", "--quiet", "--no-verify", "--no-edit"], {
      env: this.#identity(),
    });
    return true;
  }

  async #isWorktree(dir: string): Promise<boolean> {
    if (!existsSync(dir)) return false;
    // Only a worktree git lists for this repository counts: a stray folder
    // must never let git find some other repository around it.
    const list = await this.#run(this.#repoDir, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const top = await this.#exec(dir, ["rev-parse", "--show-toplevel"]);
    return (
      top.exitCode === 0 &&
      parseWorktrees(list.stdout).some((worktree) =>
        samePath(worktree.dir, top.stdout.trim()),
      )
    );
  }

  /** A commit of exactly these files on top of `parent`'s tree. */
  async #commitFiles(
    files: readonly TemplateFile[],
    parent: string | null,
    message: string,
  ): Promise<string> {
    const index = join(this.#repoDir, `sdlc-index-${randomUUID()}`);
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
    const resolved = await this.#exec(cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
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

  /** Runs git; the exit code is the caller's to judge. */
  #exec(
    cwd: string,
    args: readonly string[],
    options: { input?: string; env?: Record<string, string> } = {},
  ): Promise<GitOutput> {
    return this.#git([...this.#safety, ...args], {
      cwd,
      input: options.input,
      // git never looks for a repository above the Run's own folders.
      env: { GIT_CEILING_DIRECTORIES: this.#ceilings, ...options.env },
    });
  }

  /** Runs git and throws if it fails. */
  async #run(
    cwd: string,
    args: readonly string[],
    options: { input?: string; env?: Record<string, string> } = {},
  ): Promise<GitOutput> {
    const output = await this.#exec(cwd, args, options);
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

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * `git cat-file --batch` output: "<sha> <type> <size>\n<bytes>\n" per object.
 * An object that is not UTF-8 text (an image, a font) is null.
 */
export function parseBatch(bytes: Buffer): Array<string | null> {
  const contents: Array<string | null> = [];
  let at = 0;
  while (at < bytes.length) {
    const newline = bytes.indexOf(0x0a, at);
    const header = bytes.subarray(at, newline).toString("utf8");
    const size = Number(header.split(" ")[2]);
    if (!Number.isInteger(size))
      throw new Error(`Unexpected git cat-file output: ${header}`);
    const start = newline + 1;
    contents.push(asText(bytes.subarray(start, start + size)));
    at = start + size + 1;
  }
  return contents;
}

function asText(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/** git prints Windows paths with "/", Node joins them with "\\". */
function samePath(a: string, b: string): boolean {
  const normal = (path: string) => resolve(path).toLowerCase();
  return process.platform === "win32"
    ? normal(a) === normal(b)
    : resolve(a) === resolve(b);
}
