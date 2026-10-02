/**
 * Delivery over a real database, with a fake GitHub and a fake Workspace
 * manager: what reaches the Target Repo, and what never does (UML diagram 3b).
 */
import {
  GitHubApiError,
  type GitHubClient,
  type GitPusher,
  type PullRequest,
  type PushRequest,
} from "@sdlc-code/clients";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../persistence/database.js";
import { SqliteRunStore } from "../persistence/runStore.js";
import { SqliteSliceStore } from "../persistence/sliceStore.js";
import { SqliteTaskStore } from "../persistence/taskStore.js";
import type { WorkspaceManager } from "../workspaces/workspaceManager.js";
import { GitHubRunDelivery, type RunDelivery } from "./runDelivery.js";

/** What happened to the repository, in order, including the push. */
type Step = "discardUnfinished" | "push";

function setup(
  options: { commits?: string[]; emptyRepo?: 404 | 409 | false } = {},
) {
  const db = openDatabase(":memory:");
  const store = { db };
  const runs = new SqliteRunStore(store);
  const slices = new SqliteSliceStore(store);
  const tasks = new SqliteTaskStore(store);
  const run = runs.createRun({
    projectRequest: "Build a todo app where a user can add and delete todos.",
    mode: "gated",
    targetRepo: {
      owner: "ChinGuang",
      name: "sdlc-code-demo-todo",
      baseBranch: "main",
      runBranch: "sdlc/todo",
    },
    stackProfile: "react-node",
    tokenBudget: 1_000_000,
  });

  const steps: Step[] = [];
  let commits = options.commits ?? ["commit-1"];
  const workspaces = {
    sliceCommits: async () => commits,
    lastSliceCommit: async () => commits.at(-1) ?? "start",
    discardUnfinished: async () => {
      steps.push("discardUnfinished");
    },
  } as unknown as WorkspaceManager;

  const pushes: PushRequest[] = [];
  const pusher: GitPusher = {
    push: async (request) => {
      steps.push("push");
      pushes.push(request);
    },
  };

  const opened: Array<{ title: string; body: string; draft: boolean }> = [];
  let existing: PullRequest | null = null;
  const github = {
    // An empty repository has no base branch yet (T25).
    getBranchSha: async () => {
      if (options.emptyRepo === 404)
        throw new GitHubApiError(404, null, "GitHub 404: Branch not found");
      if (options.emptyRepo === 409)
        throw new GitHubApiError(
          409,
          null,
          "GitHub 409: Git Repository is empty.",
        );
      return "base-sha";
    },
    findOpenPullRequest: async () => existing,
    openPullRequest: async (
      _repo: unknown,
      pullRequest: { title: string; body: string; draft?: boolean },
    ): Promise<PullRequest> => {
      opened.push({ ...pullRequest, draft: pullRequest.draft ?? false });
      return {
        number: 42,
        url: "https://github.com/ChinGuang/sdlc-code-demo-todo/pull/42",
        draft: pullRequest.draft ?? false,
        branch: "sdlc/todo",
      };
    },
  } as unknown as GitHubClient;

  // Tests depend on the interface; only this factory knows the class.
  const delivery: RunDelivery = new GitHubRunDelivery({
    runs,
    slices,
    tasks,
    workspaces,
    pusher,
    github,
    repoDir: "/runs/1/repo.git",
  });
  return {
    delivery,
    runs,
    slices,
    tasks,
    run,
    steps,
    pushes,
    opened,
    setCommits: (next: string[]) => {
      commits = next;
    },
    setExisting: (next: PullRequest | null) => {
      existing = next;
    },
  };
}

/** Two Slices: the first passed, the second was still being built. */
function oneOfTwo(context: ReturnType<typeof setup>) {
  const [first, second] = context.slices.saveSlices(context.run.id, [
    { title: "Walking Skeleton", isWalkingSkeleton: true },
    { title: "Todos", isWalkingSkeleton: false },
  ]);
  context.slices.moveSlice(first!.id, "building");
  context.slices.moveSlice(first!.id, "testing");
  context.slices.moveSlice(first!.id, "passed", "commit-1");
  context.slices.moveSlice(second!.id, "building");
  return { first: first!, second: second! };
}

describe("GitHubRunDelivery: a Run that built every Slice", () => {
  it("pushes the run branch and opens a ready pull request", async () => {
    const context = setup();
    const [only] = context.slices.saveSlices(context.run.id, [
      { title: "Walking Skeleton", isWalkingSkeleton: true },
    ]);
    context.slices.moveSlice(only!.id, "building");
    context.slices.moveSlice(only!.id, "testing");
    context.slices.moveSlice(only!.id, "passed", "commit-1");

    const outcome = await context.delivery.deliver(context.run.id, {
      ended: "complete",
      findings: [
        {
          ruleId: "CLEAN-01",
          location: "src/App.tsx:12",
          message: "`d` says nothing about what it holds.",
        },
      ],
    });

    expect(outcome).toMatchObject({ status: "opened" });
    expect(context.pushes).toEqual([
      {
        repoDir: "/runs/1/repo.git",
        repo: context.run.targetRepo,
        branch: "sdlc/todo",
      },
    ]);
    expect(context.opened[0]?.draft).toBe(false);
    expect(context.opened[0]?.body).toContain("CLEAN-01");
    expect(context.opened[0]?.body).toContain("- [x] Walking Skeleton");
    // Nothing is thrown away when every Slice passed.
    expect(context.steps).toEqual(["push"]);
  });

  it("records the pull request on the Run", async () => {
    const context = setup();
    oneOfTwo(context);

    await context.delivery.deliver(context.run.id, {
      ended: "complete",
      findings: [],
    });

    expect(context.runs.getRun(context.run.id)?.pullRequest).toEqual({
      number: 42,
      url: "https://github.com/ChinGuang/sdlc-code-demo-todo/pull/42",
      draft: false,
    });
  });
});

describe("GitHubRunDelivery: a Run that stopped early (diagram 3b)", () => {
  it("throws away the unfinished Slice before pushing a Draft PR", async () => {
    const context = setup();
    oneOfTwo(context);
    context.runs.recordFailure(context.run.id, {
      trigger: "retryBudget",
      summary: "Still failing after 3 retries: Todos > empty state",
      slice: "Todos",
      reports: [
        {
          failingTest: "Todos > empty state",
          step: "unit",
          error: "expected 1",
        },
      ],
    });

    const outcome = await context.delivery.deliver(context.run.id, {
      ended: "failed",
      openDraftPr: true,
    });

    expect(outcome).toMatchObject({ status: "opened" });
    // The unfinished work is gone before anything is pushed, never after.
    expect(context.steps).toEqual(["discardUnfinished", "push"]);
    const [pull] = context.opened;
    expect(pull?.draft).toBe(true);
    expect(pull?.body).toContain("- [x] Walking Skeleton");
    expect(pull?.body).toContain("- [ ] Todos (not included)");
    expect(pull?.body).toContain("Todos > empty state: expected 1");
    expect(pull?.body).toContain("Still failing after 3 retries");
  });

  it("titles a Draft PR with how far the Run got", async () => {
    const context = setup();
    oneOfTwo(context);

    await context.delivery.deliver(context.run.id, {
      ended: "aborted",
      openDraftPr: true,
    });

    expect(context.opened[0]?.title).toMatch(
      /^\[Aborted\] .* — 1 of 2 slices$/,
    );
  });

  it("carries the unfinished Slice's Working Memory, not its Transcript", async () => {
    const context = setup();
    const { second } = oneOfTwo(context);
    const task = context.tasks.createTask({
      runId: context.run.id,
      sliceId: second.id,
      agentRole: "frontendCoding",
    });
    const step = context.tasks.startStep(task.id);
    context.tasks.appendStepEvent(step.id, "message", { role: "user" });
    context.tasks.completeStep(step.id, "- the empty state test still fails");

    await context.delivery.deliver(context.run.id, {
      ended: "aborted",
      openDraftPr: true,
    });

    const body = context.opened[0]!.body;
    expect(body).toContain("**frontendCoding**");
    expect(body).toContain("- the empty state test still fails");
    expect(body).not.toContain('"role"');
  });

  it("pushes nothing when the person declined the draft pull request", async () => {
    const context = setup();
    oneOfTwo(context);

    const outcome = await context.delivery.deliver(context.run.id, {
      ended: "aborted",
      openDraftPr: false,
    });

    expect(outcome).toEqual({
      status: "keptLocal",
      reason: "draftPrDeclined",
    });
    expect(context.steps).toEqual([]);
    expect(context.pushes).toEqual([]);
    expect(context.opened).toEqual([]);
    expect(context.runs.getRun(context.run.id)?.pullRequest).toBeNull();
  });

  it("pushes nothing when no Slice ever passed", async () => {
    const context = setup({ commits: [] });
    const [only] = context.slices.saveSlices(context.run.id, [
      { title: "Walking Skeleton", isWalkingSkeleton: true },
    ]);
    context.slices.moveSlice(only!.id, "building");

    const outcome = await context.delivery.deliver(context.run.id, {
      ended: "failed",
      openDraftPr: true,
    });

    expect(outcome).toEqual({ status: "keptLocal", reason: "noSliceCommit" });
    expect(context.pushes).toEqual([]);
    expect(context.opened).toEqual([]);
    // It still tidied up: the unfinished work is not kept either way.
    expect(context.steps).toEqual(["discardUnfinished"]);
  });
});

describe("GitHubRunDelivery: a branch that already has a pull request", () => {
  it("reuses the open one instead of failing to open a second", async () => {
    const context = setup();
    oneOfTwo(context);
    context.setExisting({
      number: 7,
      url: "https://github.com/ChinGuang/sdlc-code-demo-todo/pull/7",
      draft: true,
      branch: "sdlc/todo",
    });

    const outcome = await context.delivery.deliver(context.run.id, {
      ended: "complete",
      findings: [],
    });

    expect(outcome).toMatchObject({ status: "opened" });
    expect(context.opened).toEqual([]);
    expect(context.runs.getRun(context.run.id)?.pullRequest).toMatchObject({
      number: 7,
    });
  });
});

describe("GitHubRunDelivery and its collaborators' tokens", () => {
  it("never exposes the clients it pushes and opens pull requests with", () => {
    const { delivery } = setup();

    expect(Object.keys(delivery)).toEqual(["deliver"]);
    expect(JSON.stringify(delivery)).toBe("{}");
    expect("pusher" in delivery).toBe(false);
    expect("github" in delivery).toBe(false);
  });
});

describe("GitHubRunDelivery: a Run it cannot deliver", () => {
  it("says which Run it could not find", async () => {
    const context = setup();

    await expect(
      context.delivery.deliver("no-such-run", {
        ended: "complete",
        findings: [],
      }),
    ).rejects.toThrow(/No Run no-such-run/);
  });
});

// Found in T25: the demo repository was empty, so there was no main to open a
// pull request into, and none with any history in common with the Run.
describe("GitHubRunDelivery: an empty Target Repo (T25)", () => {
  // GitHub answers a missing branch with 404 and a repository with no commits
  // at all with 409 ("Git Repository is empty"), which is what T25 met live.
  it.each([404, 409] as const)(
    "begins its base branch at the Run's start commit, then pushes the Run (GitHub says %s)",
    async (status) => {
      const context = setup({ emptyRepo: status });

      await context.delivery.deliver(context.run.id, {
        ended: "complete",
        findings: [],
      });

      expect(context.pushes).toEqual([
        {
          repoDir: "/runs/1/repo.git",
          repo: expect.objectContaining({ name: "sdlc-code-demo-todo" }),
          branch: "main",
          source: "refs/sdlc-run/start",
        },
        expect.objectContaining({ branch: "sdlc/todo" }),
      ]);
      expect(context.opened).toHaveLength(1);
    },
  );

  it("leaves a base branch that exists alone", async () => {
    const context = setup();

    await context.delivery.deliver(context.run.id, {
      ended: "complete",
      findings: [],
    });

    expect(context.pushes.map((push) => push.branch)).toEqual(["sdlc/todo"]);
  });
});
