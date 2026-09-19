import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitPushError,
  TokenGitPusher,
  type GitPusher,
  type GitPusherOptions,
  type GitRunner,
} from "./gitPusher.js";

// Tests depend on the interface; only this factory knows the class.
const makePusher = (options: GitPusherOptions): GitPusher =>
  new TokenGitPusher(options);

const repo = { owner: "ChinGuang", name: "sdlc-code-demo-todo" };
const TOKEN = "github_pat_secret_123";

type GitCall = Parameters<GitRunner>;

function fakeGit(result = { exitCode: 0, stdout: "", stderr: "" }) {
  const calls: GitCall[] = [];
  const runGit: GitRunner = async (...args) => {
    calls.push(args);
    return result;
  };
  return { runGit, calls };
}

describe("TokenGitPusher", () => {
  it("pushes the branch to the Target Repo with the PAT in git's env config, not argv", async () => {
    const { runGit, calls } = fakeGit();

    await makePusher({ token: TOKEN, runGit }).push({
      repoDir: "/work/run-1",
      repo,
      branch: "sdlc/run-1",
    });

    const [args, options] = calls[0]!;
    expect(args).toEqual([
      "-c",
      "credential.helper=",
      "push",
      "--porcelain",
      "https://github.com/ChinGuang/sdlc-code-demo-todo.git",
      "refs/heads/sdlc/run-1:refs/heads/sdlc/run-1",
    ]);
    expect(args.join(" ")).not.toContain(TOKEN);
    expect(options.cwd).toBe("/work/run-1");
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    expect(options.env).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    });
  });

  it("force-pushes with a + refspec (run branch reset to its last Slice Commit)", async () => {
    const { runGit, calls } = fakeGit();

    await makePusher({ token: TOKEN, runGit }).push({
      repoDir: "/w",
      repo,
      branch: "sdlc/run-1",
      force: true,
    });

    expect(calls[0]![0].at(-1)).toBe(
      "+refs/heads/sdlc/run-1:refs/heads/sdlc/run-1",
    );
  });

  it.each(["-delete", "a..b", "a b", "a/", "x.lock", "", "a~1", "a:b"])(
    "rejects the unsafe branch name %j without running git",
    async (branch) => {
      const { runGit, calls } = fakeGit();

      await expect(
        makePusher({ token: TOKEN, runGit }).push({
          repoDir: "/w",
          repo,
          branch,
        }),
      ).rejects.toThrow(/invalid branch name/);
      expect(calls).toEqual([]);
    },
  );

  it("fails with git's stderr, with the PAT and its encoded form redacted", async () => {
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    const { runGit } = fakeGit({
      exitCode: 128,
      stdout: "",
      stderr: `fatal: Authentication failed (${TOKEN}) header ${basic}`,
    });

    const error = await makePusher({ token: TOKEN, runGit })
      .push({ repoDir: "/w", repo, branch: "b" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitPushError);
    expect(String(error)).toMatch(/exit 128.*Authentication failed/);
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain(basic);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("never exposes the token", () => {
    const pusher = makePusher({ token: TOKEN });

    expect(Object.keys(pusher)).toEqual(["push"]);
    expect(JSON.stringify(pusher)).not.toContain(TOKEN);
  });
});

describe("TokenGitPusher with real git", () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "sdlc-push-"));
    dirs.push(dir);
    return dir;
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it("pushes a local branch to a remote", async () => {
    const remoteRoot = tempDir();
    const bare = join(remoteRoot, repo.owner, `${repo.name}.git`);
    execFileSync("git", ["init", "-q", "--bare", bare]);
    const work = tempDir();
    git(work, "init", "-q", "-b", "sdlc/run-1");
    writeFileSync(join(work, "README.md"), "slice 1\n");
    git(work, "add", ".");
    git(
      work,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "-m",
      "Slice 1",
    );

    await makePusher({
      token: TOKEN,
      baseUrl: pathToFileURL(remoteRoot).href,
    }).push({ repoDir: work, repo, branch: "sdlc/run-1" });

    expect(git(bare, "rev-parse", "refs/heads/sdlc/run-1")).toBe(
      git(work, "rev-parse", "HEAD"),
    );
  });
});
