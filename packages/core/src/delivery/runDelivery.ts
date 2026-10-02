/**
 * Delivering a Run's work as a pull request (T20, UML diagrams 3b and 8).
 *
 * A Run that built every Slice opens an ordinary pull request carrying the
 * non-blocking Findings. A Run that stopped early — aborted by a person with
 * "Open draft PR" ticked, or failed in auto mode — opens a Draft PR instead,
 * and only ever with code that passed a Test Run: the unfinished Slice's
 * Workspaces are discarded before anything is pushed. The run branch itself
 * needs no repair, because only a passing Test Run ever moves it.
 *
 * Nothing is pushed when there is no Slice Commit, or when the person said not
 * to. A Run's work then stays in its local repository, where it already is.
 */
import {
  GitHubApiError,
  type GitHubClient,
  type GitPusher,
  type PullRequest,
} from "@sdlc-code/clients";
import type { Run, Slice } from "../domain/entities.js";
import type { RunStore } from "../persistence/runStore.js";
import type { SliceStore } from "../persistence/sliceStore.js";
import type { TaskStore } from "../persistence/taskStore.js";
import {
  START_REF,
  type WorkspaceManager,
} from "../workspaces/workspaceManager.js";
import {
  pullRequestBody,
  pullRequestTitle,
  type PullRequestFinding,
  type RunOutcome,
} from "./pullRequestText.js";

/** Why a Run is being delivered, which decides what kind of PR it gets. */
export type DeliveryReason =
  | { ended: "complete"; findings: readonly PullRequestFinding[] }
  /** Stopped early: a Draft PR, and only if `openDraftPr`. */
  | { ended: "aborted" | "failed"; openDraftPr: boolean };

export type DeliveryOutcome =
  | { status: "opened"; pullRequest: PullRequest }
  /** Nothing was pushed, and why not; the Run's work stays local. */
  | {
      status: "keptLocal";
      reason: "noSliceCommit" | "draftPrDeclined" | "noTargetRepo";
    };

/** Opens the pull request a Run's work belongs in. */
export interface RunDelivery {
  deliver: (runId: string, reason: DeliveryReason) => Promise<DeliveryOutcome>;
}

export type RunDeliveryOptions = {
  runs: RunStore;
  slices: SliceStore;
  tasks: TaskStore;
  /** The Run's local repository: what is pushed, and what is tidied first. */
  workspaces: WorkspaceManager;
  pusher: GitPusher;
  github: GitHubClient;
  /** The repository the Workspaces are in, which is what gets pushed. */
  repoDir: string;
};

export class GitHubRunDelivery implements RunDelivery {
  #options: RunDeliveryOptions;

  constructor(options: RunDeliveryOptions) {
    this.#options = options;
  }

  deliver = async (
    runId: string,
    reason: DeliveryReason,
  ): Promise<DeliveryOutcome> => {
    const { runs, workspaces, pusher, repoDir } = this.#options;
    const run = runs.getRun(runId);
    if (!run) throw new Error(`No Run ${runId} to deliver.`);
    const stoppedEarly = reason.ended !== "complete";
    if (stoppedEarly && !reason.openDraftPr)
      return { status: "keptLocal", reason: "draftPrDeclined" };

    // Diagram 3b: the unfinished Slice never reaches the Target Repo. Discarding
    // before counting means the count is of what will actually be pushed.
    if (stoppedEarly) await workspaces.discardUnfinished();
    const commits = await workspaces.sliceCommits();
    if (commits.length === 0)
      return { status: "keptLocal", reason: "noSliceCommit" };

    const content = this.#pullRequestContent(run, reason);
    await this.#beginBaseIfMissing(run);
    await pusher.push({
      repoDir,
      repo: run.targetRepo,
      branch: run.targetRepo.runBranch,
    });
    const pullRequest = await this.#openOrReuse(run, {
      head: run.targetRepo.runBranch,
      base: run.targetRepo.baseBranch,
      title: pullRequestTitle(content),
      body: pullRequestBody(content),
      draft: stoppedEarly,
    });
    runs.setPullRequest(runId, {
      number: pullRequest.number,
      url: pullRequest.url,
      draft: pullRequest.draft,
    });
    return { status: "opened", pullRequest };
  };

  /**
   * An empty Target Repo has no base branch to open a pull request into, and
   * GitHub refuses one between branches with no history in common. So its
   * base begins at the Run's start commit, the template (found in T25: the
   * demo repository was empty); the pull request then carries the Slices.
   */
  async #beginBaseIfMissing(run: Run): Promise<void> {
    const { github, pusher, repoDir } = this.#options;
    try {
      await github.getBranchSha(run.targetRepo, run.targetRepo.baseBranch);
      return;
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404)
        throw error;
    }
    await pusher.push({
      repoDir,
      repo: run.targetRepo,
      branch: run.targetRepo.baseBranch,
      source: START_REF,
    });
  }

  /**
   * A Run's branch may already have a pull request: a Run that was resumed, or
   * one whose PR Gate sent work back. GitHub refuses a second one for the same
   * head, so the open one is reused rather than reported as a failure.
   */
  async #openOrReuse(
    run: Run,
    pullRequest: {
      head: string;
      base: string;
      title: string;
      body: string;
      draft: boolean;
    },
  ): Promise<PullRequest> {
    const { github } = this.#options;
    const existing = await github.findOpenPullRequest(
      run.targetRepo,
      pullRequest.head,
    );
    return (
      existing ?? (await github.openPullRequest(run.targetRepo, pullRequest))
    );
  }

  /** What the pull request says, read from the Run's own record. */
  #pullRequestContent(run: Run, reason: DeliveryReason): RunOutcome {
    const planned = this.#options.slices.listSlices(run.id);
    const passed = planned.filter((slice) => slice.status === "passed");
    const summary = `${passed.length} of ${planned.length} Slices of "${oneLine(run.projectRequest)}" were built and tested in a sandbox.`;
    if (reason.ended === "complete")
      return {
        outcome: "complete",
        runId: run.id,
        requestTitle: run.projectRequest,
        summary,
        slices: passed.map((slice) => slice.title),
        findings: [...reason.findings],
      };
    const unfinished = planned.find(
      (slice) => slice.status !== "passed" && slice.status !== "skipped",
    );
    return {
      outcome: reason.ended,
      runId: run.id,
      requestTitle: run.projectRequest,
      summary,
      stopReason: run.failure?.summary ?? "The Run was stopped.",
      passedSlices: passed.map((slice) => slice.title),
      totalSlices: planned.length,
      failedSlice: unfinished
        ? {
            name: unfinished.title,
            issueReports: issueLines(run.failure?.reports ?? []),
          }
        : null,
      workingMemory: this.#workingMemory(run.id, unfinished),
    };
  }

  /**
   * What the agents last wrote down about the unfinished Slice, so whoever picks
   * it up starts where they left off rather than from the Transcript.
   */
  #workingMemory(runId: string, unfinished: Slice | undefined): string {
    if (!unfinished) return "None recorded.";
    const notes = this.#options.tasks
      .listTasks(runId)
      .filter((task) => task.sliceId === unfinished.id)
      .flatMap((task) =>
        this.#options.tasks
          .listSteps(task.id)
          .filter((step) => step.status === "completed" && step.workingMemory)
          .slice(-1)
          .map((step) => `**${task.agentRole}**\n${step.workingMemory}`),
      );
    return notes.length > 0 ? notes.join("\n\n") : "None recorded.";
  }
}

/** Issue Reports as stored: only their text matters to a reader. */
function issueLines(reports: readonly unknown[]): string[] {
  return reports.flatMap((report) => {
    if (typeof report !== "object" || report === null) return [];
    const { failingTest, step, error } = report as {
      failingTest?: unknown;
      step?: unknown;
      error?: unknown;
    };
    const where =
      typeof failingTest === "string" && failingTest
        ? failingTest
        : typeof step === "string"
          ? `${step} step`
          : "unknown step";
    return [`${where}: ${typeof error === "string" ? error : "no error text"}`];
  });
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
