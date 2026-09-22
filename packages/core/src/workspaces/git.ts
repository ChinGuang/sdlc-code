/**
 * Runs git for the Workspace manager: never interactive, never the user's
 * hooks, and the same bytes on disk as in the repository on every platform.
 */
import { spawn } from "node:child_process";

export type GitOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout as git wrote it, for output measured in bytes. */
  bytes: Buffer;
};

export type GitOptions = {
  cwd: string;
  /** Written to git's stdin. */
  input?: string;
  env?: Record<string, string>;
};

/** Runs `git <args>` and reports how it ended; it never throws for a git failure. */
export type GitCommand = (
  args: readonly string[],
  options: GitOptions,
) => Promise<GitOutput>;

/**
 * Configuration for every call. Commits are made by the Run, unattended:
 * a signing prompt would hang it, a user's hook would run on generated code,
 * and line-ending conversion would make a Workspace differ from its commit.
 */
export function gitSafetyConfig(noHooksDir: string): string[] {
  return [
    "-c",
    `core.hooksPath=${noHooksDir}`,
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    // Worktrees share one repository; a background gc must not race them.
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
  ];
}

export const runGitCommand: GitCommand = (args, { cwd, input, env }) =>
  new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) =>
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: error.message,
        bytes: Buffer.alloc(0),
      }),
    );
    child.on("close", (code) => {
      const bytes = Buffer.concat(stdout);
      resolve({
        exitCode: code ?? 1,
        stdout: bytes.toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        bytes,
      });
    });
    // git may exit before reading all of stdin; its exit code says why.
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });

export class GitError extends Error {
  readonly exitCode: number;

  constructor(args: readonly string[], output: GitOutput) {
    super(
      `git ${args.join(" ")} failed (exit ${output.exitCode}): ${(output.stderr || output.stdout).trim().slice(0, 1000)}`,
    );
    this.name = "GitError";
    this.exitCode = output.exitCode;
  }
}
