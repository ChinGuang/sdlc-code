/**
 * Pushes a local run branch (Slice Commits) to the Target Repo with the PAT.
 * The PAT goes to git through GIT_CONFIG_* env vars as an HTTP header, so it
 * never appears in argv (visible to other processes), the remote URL, or
 * .git/config, and is redacted from any error.
 */
import { execFile } from "node:child_process";
import type { RepoRef } from "./githubClient.js";

export const GIT_DEFAULT_BASE_URL = "https://github.com";

export type GitResult = { exitCode: number; stdout: string; stderr: string };

/** Runs `git <args>`; `env` is added to the inherited environment. */
export type GitRunner = (
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => Promise<GitResult>;

export type PushRequest = {
  /** Local repository (or worktree) holding the branch. */
  repoDir: string;
  repo: RepoRef;
  branch: string;
  /** Overwrite the remote branch, e.g. after resetting to the last Slice Commit. */
  force?: boolean;
};

export type GitPusherOptions = {
  token: string;
  /** Git host root; the remote is `${baseUrl}/${owner}/${name}.git`. */
  baseUrl?: string;
  runGit?: GitRunner;
};

/** Pushes a Run's branch to its Target Repo. */
export interface GitPusher {
  push: (request: PushRequest) => Promise<void>;
}

export class GitPushError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.name = "GitPushError";
    this.exitCode = exitCode;
  }
}

/** GitPusher that authenticates git over HTTPS with a PAT. */
export class TokenGitPusher implements GitPusher {
  #token: string;
  #baseUrl: string;
  #runGit: GitRunner;

  constructor(options: GitPusherOptions) {
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? GIT_DEFAULT_BASE_URL).replace(
      /\/$/,
      "",
    );
    this.#runGit = options.runGit ?? runGit;
  }

  push = async ({
    repoDir,
    repo,
    branch,
    force = false,
  }: PushRequest): Promise<void> => {
    if (!isSafeBranchName(branch))
      throw new Error(`invalid branch name: ${JSON.stringify(branch)}`);
    const remote = `${this.#baseUrl}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}.git`;
    const refspec = `${force ? "+" : ""}refs/heads/${branch}:refs/heads/${branch}`;
    const result = await this.#runGit(
      // An empty credential.helper stops the user's own git credentials being used.
      ["-c", "credential.helper=", "push", "--porcelain", remote, refspec],
      {
        cwd: repoDir,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `http.${this.#baseUrl}/.extraheader`,
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${this.#basicAuth()}`,
        },
      },
    );
    if (result.exitCode !== 0) {
      const output = (result.stderr || result.stdout).trim().slice(0, 1000);
      throw new GitPushError(
        result.exitCode,
        this.#redact(`git push failed (exit ${result.exitCode}): ${output}`),
      );
    }
  };

  #basicAuth(): string {
    return Buffer.from(`x-access-token:${this.#token}`).toString("base64");
  }

  #redact(text: string): string {
    if (this.#token === "") return text;
    return text
      .replaceAll(this.#token, "[redacted]")
      .replaceAll(this.#basicAuth(), "[redacted]");
  }
}

/**
 * A conservative subset of `git check-ref-format`: also rejects a leading "-",
 * so a branch name can never be read as a git option.
 */
export function isSafeBranchName(branch: string): boolean {
  return (
    branch !== "" &&
    !branch.startsWith("-") &&
    !branch.startsWith("/") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".") &&
    !branch.endsWith(".lock") &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.includes("@{") &&
    !branch.split("/").some((part) => part.startsWith(".")) &&
    // eslint-disable-next-line no-control-regex
    !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(branch)
  );
}

const runGit: GitRunner = (args, { cwd, env }) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, ...env }, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = error?.code;
        resolve({
          exitCode: error ? (typeof code === "number" ? code : 1) : 0,
          stdout,
          stderr:
            stderr || (error && typeof code !== "number" ? error.message : ""),
        });
      },
    );
  });
