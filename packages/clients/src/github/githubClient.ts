/**
 * GitHub REST client for delivering a Run into the Target Repo: check access,
 * create a branch, open a pull request (ready or draft).
 * Pushing commits is git's job: see gitPusher.ts.
 * API reference: https://docs.github.com/en/rest
 */

export const GITHUB_DEFAULT_BASE_URL = "https://api.github.com";

export type RepoRef = { owner: string; name: string };

export type RepoInfo = {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  url: string;
  /** False when the PAT lacks "Contents: write" on this repo. */
  canPush: boolean;
};

export type NewPullRequest = {
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
};

export type PullRequest = {
  number: number;
  url: string;
  draft: boolean;
  branch: string;
};

export type GitHubClientOptions = {
  /** Fine-grained PAT (Contents + Pull requests: write on the Target Repo). */
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Milliseconds since epoch; used to turn rate-limit resets into a wait. */
  now?: () => number;
};

/** The GitHub operations a Run needs to deliver into its Target Repo. */
export interface GitHubClient {
  getRepo: (repo: RepoRef) => Promise<RepoInfo>;
  getBranchSha: (repo: RepoRef, branch: string) => Promise<string>;
  createBranch: (
    repo: RepoRef,
    branch: { branch: string; fromSha: string },
  ) => Promise<void>;
  openPullRequest: (
    repo: RepoRef,
    pullRequest: NewPullRequest,
  ) => Promise<PullRequest>;
  /** The open PR whose head is `branch` in the same repo, or null. */
  findOpenPullRequest: (
    repo: RepoRef,
    branch: string,
  ) => Promise<PullRequest | null>;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    retryAfterSeconds: number | null,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type RawRepo = {
  full_name: string;
  default_branch: string;
  private: boolean;
  html_url: string;
  permissions?: { push?: boolean };
};

type RawPull = {
  number: number;
  html_url: string;
  draft?: boolean;
  head: { ref: string };
};

/** GitHubClient over the GitHub REST API. */
export class RestGitHubClient implements GitHubClient {
  #token: string;
  #baseUrl: string;
  #fetch: typeof fetch;
  #now: () => number;

  constructor(options: GitHubClientOptions) {
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? GITHUB_DEFAULT_BASE_URL).replace(
      /\/$/,
      "",
    );
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  getRepo = async (repo: RepoRef): Promise<RepoInfo> => {
    const raw = await this.#request<RawRepo>("GET", repoPath(repo));
    return {
      fullName: raw.full_name,
      defaultBranch: raw.default_branch,
      private: raw.private,
      url: raw.html_url,
      canPush: raw.permissions?.push ?? false,
    };
  };

  getBranchSha = async (repo: RepoRef, branch: string): Promise<string> => {
    const raw = await this.#request<{ object: { sha: string } }>(
      "GET",
      `${repoPath(repo)}/git/ref/heads/${branchPath(branch)}`,
    );
    return raw.object.sha;
  };

  createBranch = async (
    repo: RepoRef,
    { branch, fromSha }: { branch: string; fromSha: string },
  ): Promise<void> => {
    await this.#request("POST", `${repoPath(repo)}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: fromSha,
    });
  };

  openPullRequest = async (
    repo: RepoRef,
    pullRequest: NewPullRequest,
  ): Promise<PullRequest> => {
    const raw = await this.#request<RawPull>(
      "POST",
      `${repoPath(repo)}/pulls`,
      { ...pullRequest, draft: pullRequest.draft ?? false },
    );
    return toPullRequest(raw);
  };

  findOpenPullRequest = async (
    repo: RepoRef,
    branch: string,
  ): Promise<PullRequest | null> => {
    const query = new URLSearchParams({
      state: "open",
      head: `${repo.owner}:${branch}`,
    });
    const raw = await this.#request<RawPull[]>(
      "GET",
      `${repoPath(repo)}/pulls?${query}`,
    );
    return raw[0] ? toPullRequest(raw[0]) : null;
  };

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "sdlc-code",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        retryAfterSeconds(response.headers, this.#now()),
        redact(`GitHub ${response.status}: ${errorMessage(text)}`, this.#token),
      );
    }
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }
}

function repoPath(repo: RepoRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** Branch names may contain "/", which GitHub expects unencoded in ref paths. */
function branchPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function toPullRequest(raw: RawPull): PullRequest {
  return {
    number: raw.number,
    url: raw.html_url,
    draft: raw.draft ?? false,
    branch: raw.head.ref,
  };
}

/** Retry-After (secondary limits) wins; else the primary limit's reset time. */
function retryAfterSeconds(headers: Headers, nowMs: number): number | null {
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0)
      return Math.max(0, Math.ceil(reset - nowMs / 1000));
  }
  return null;
}

function errorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      message?: string;
      errors?: Array<{ message?: string; code?: string }>;
    };
    const details = (parsed.errors ?? [])
      .map((error) => error.message ?? error.code)
      .filter(Boolean);
    if (parsed.message)
      return [parsed.message, ...details].join(" — ").slice(0, 500);
  } catch {
    // not JSON: fall through to the raw text
  }
  return text.slice(0, 500);
}

function redact(text: string, token: string): string {
  return token === "" ? text : text.replaceAll(token, "[redacted]");
}
