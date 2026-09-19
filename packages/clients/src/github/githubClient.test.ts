import { describe, expect, it, vi } from "vitest";
import {
  GitHubApiError,
  RestGitHubClient,
  type GitHubClient,
  type GitHubClientOptions,
} from "./githubClient.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(
  responses: Array<{
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }>,
) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${String(url)}`);
    return new Response(
      next.body === undefined ? null : JSON.stringify(next.body),
      {
        status: next.status,
        headers: { "content-type": "application/json", ...next.headers },
      },
    );
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

// Tests depend on the interface; only this factory knows the class.
const makeClient = (options: GitHubClientOptions): GitHubClient =>
  new RestGitHubClient(options);

const base = { token: "ghp-secret-123", baseUrl: "https://gh.test" };
const repo = { owner: "ChinGuang", name: "sdlc-code-demo-todo" };
const bodyOf = (call: Call | undefined) => JSON.parse(String(call!.init.body));

const pullResponse = {
  number: 7,
  html_url: "https://github.com/ChinGuang/sdlc-code-demo-todo/pull/7",
  draft: true,
  head: { ref: "sdlc/run-1" },
};

describe("RestGitHubClient requests", () => {
  it("sends the PAT as a bearer token with GitHub's API headers", async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 200,
        body: {
          full_name: "ChinGuang/sdlc-code-demo-todo",
          default_branch: "main",
          private: false,
          html_url: "https://github.com/ChinGuang/sdlc-code-demo-todo",
          permissions: { pull: true, push: true, admin: false },
        },
      },
    ]);

    const info = await makeClient({ ...base, fetch }).getRepo(repo);

    expect(calls[0]!.url).toBe(
      "https://gh.test/repos/ChinGuang/sdlc-code-demo-todo",
    );
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer ghp-secret-123");
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("user-agent")).toBe("sdlc-code");
    expect(info).toEqual({
      fullName: "ChinGuang/sdlc-code-demo-todo",
      defaultBranch: "main",
      private: false,
      url: "https://github.com/ChinGuang/sdlc-code-demo-todo",
      canPush: true,
    });
  });

  it("reports canPush false when the PAT is read-only", async () => {
    const { fetch } = fakeFetch([
      {
        status: 200,
        body: {
          full_name: "a/b",
          default_branch: "main",
          private: true,
          html_url: "u",
          permissions: { pull: true, push: false },
        },
      },
    ]);

    const info = await makeClient({ ...base, fetch }).getRepo(repo);

    expect(info.canPush).toBe(false);
  });

  it("reads a branch head SHA, keeping slashes in the branch name", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { object: { sha: "abc123", type: "commit" } } },
    ]);

    const sha = await makeClient({ ...base, fetch }).getBranchSha(
      repo,
      "feature/login page",
    );

    expect(calls[0]!.url).toBe(
      "https://gh.test/repos/ChinGuang/sdlc-code-demo-todo/git/ref/heads/feature/login%20page",
    );
    expect(sha).toBe("abc123");
  });

  it("creates a branch from a SHA", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 201, body: { ref: "refs/heads/sdlc/run-1" } },
    ]);

    await makeClient({ ...base, fetch }).createBranch(repo, {
      branch: "sdlc/run-1",
      fromSha: "abc123",
    });

    expect(calls[0]!.url).toBe(
      "https://gh.test/repos/ChinGuang/sdlc-code-demo-todo/git/refs",
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(bodyOf(calls[0])).toEqual({
      ref: "refs/heads/sdlc/run-1",
      sha: "abc123",
    });
  });

  it("opens a ready pull request", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 201, body: { ...pullResponse, draft: false } },
    ]);

    const pr = await makeClient({ ...base, fetch }).openPullRequest(repo, {
      head: "sdlc/run-1",
      base: "main",
      title: "Todo app",
      body: "Summary",
    });

    expect(calls[0]!.url).toBe(
      "https://gh.test/repos/ChinGuang/sdlc-code-demo-todo/pulls",
    );
    expect(bodyOf(calls[0])).toEqual({
      head: "sdlc/run-1",
      base: "main",
      title: "Todo app",
      body: "Summary",
      draft: false,
    });
    expect(pr).toEqual({
      number: 7,
      url: "https://github.com/ChinGuang/sdlc-code-demo-todo/pull/7",
      draft: false,
      branch: "sdlc/run-1",
    });
  });

  it("opens a draft pull request", async () => {
    const { fetch, calls } = fakeFetch([{ status: 201, body: pullResponse }]);

    const pr = await makeClient({ ...base, fetch }).openPullRequest(repo, {
      head: "sdlc/run-1",
      base: "main",
      title: "[Aborted] Todo app — 1 of 3 slices",
      body: "Report",
      draft: true,
    });

    expect(bodyOf(calls[0]).draft).toBe(true);
    expect(pr.draft).toBe(true);
  });

  it("finds the open pull request for a branch, or null", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: [pullResponse] },
      { status: 200, body: [] },
    ]);
    const client = makeClient({ ...base, fetch });

    const found = await client.findOpenPullRequest(repo, "sdlc/run-1");
    const missing = await client.findOpenPullRequest(repo, "sdlc/run-2");

    expect(calls[0]!.url).toBe(
      "https://gh.test/repos/ChinGuang/sdlc-code-demo-todo/pulls?state=open&head=ChinGuang%3Asdlc%2Frun-1",
    );
    expect(found).toMatchObject({ number: 7, branch: "sdlc/run-1" });
    expect(missing).toBeNull();
  });
});

describe("GitHubApiError", () => {
  it("carries status, GitHub's message and validation details", async () => {
    const { fetch } = fakeFetch([
      {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [{ message: "A pull request already exists for x:y." }],
        },
      },
    ]);

    const error = await makeClient({ ...base, fetch })
      .openPullRequest(repo, { head: "y", base: "main", title: "t", body: "" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({
      status: 422,
      message: expect.stringMatching(/422.*Validation Failed.*already exists/),
    });
  });

  it("reads the rate-limit reset as seconds to wait", async () => {
    const { fetch } = fakeFetch([
      {
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1060",
        },
      },
    ]);
    const client = makeClient({ ...base, fetch, now: () => 1_000_000 });

    await expect(client.getRepo(repo)).rejects.toMatchObject({
      status: 403,
      retryAfterSeconds: 60,
    });
  });

  it("prefers Retry-After for secondary rate limits", async () => {
    const { fetch } = fakeFetch([
      {
        status: 429,
        body: { message: "secondary rate limit" },
        headers: { "retry-after": "5" },
      },
    ]);

    await expect(
      makeClient({ ...base, fetch }).getRepo(repo),
    ).rejects.toMatchObject({ retryAfterSeconds: 5 });
  });
});

describe("secrets", () => {
  it("the client never exposes the token", () => {
    const client = makeClient({ ...base, token: "ghp-secret-xyz" });

    expect(Object.keys(client).sort()).toEqual([
      "createBranch",
      "findOpenPullRequest",
      "getBranchSha",
      "getRepo",
      "openPullRequest",
    ]);
    expect(JSON.stringify(client)).not.toContain("ghp-secret-xyz");
  });

  it("errors never include the token, even if GitHub echoes it", async () => {
    const { fetch } = fakeFetch([
      { status: 401, body: { message: "Bad credentials ghp-secret-xyz" } },
    ]);

    const error = await makeClient({ ...base, token: "ghp-secret-xyz", fetch })
      .getRepo(repo)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitHubApiError);
    expect(String(error)).not.toContain("ghp-secret-xyz");
    expect(JSON.stringify(error)).not.toContain("ghp-secret-xyz");
  });

  it("public methods work when passed as callbacks", async () => {
    const { fetch } = fakeFetch([{ status: 200, body: [] }]);
    const { findOpenPullRequest } = makeClient({ ...base, fetch });

    await expect(findOpenPullRequest(repo, "b")).resolves.toBeNull();
  });
});
