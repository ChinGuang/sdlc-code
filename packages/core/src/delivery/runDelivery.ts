/**
 * Delivering a Run's work as a pull request (T20, UML diagrams 3b and 8).
 *
 * A Run that built every Slice opens an ordinary pull request carrying the
 * non-blocking Findings. A Run that stopped early — aborted by a person with
 * "Open draft PR" ticked, or failed in auto mode — opens a Draft PR instead,
 * and only ever with code that passed a Test Run: the unfinished Slice's
 * Workspaces are discarded before anything is pushed. The run branch itself
 * needs no repair, because only a passing Test Run ever moves it. That also
 * means a Slice that passed and was then sent back (by Code Review) keeps its
 * Slice Commits on the branch: the pull request says so (T25d), and why the
 * Run stopped, from the Escalation it was aborted at.
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
import type { Escalation, Run, Slice } from "../domain/entities.js";
import type { EscalationTrigger } from "../domain/runLifecycle.js";
import type { EscalationStore } from "../persistence/escalationStore.js";
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
  /** Why a Run that was aborted at an Escalation stopped. */
  escalations: EscalationStore;
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

    const content = this.#pullRequestContent(run, reason, commits);
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
   * An empty Target Repo has nothing to open a pull request into, and GitHub
   * refuses one between branches with no history in common. So its base begins
   * at the Run's start commit (the template), and the pull request carries the
   * Slices. A repository that has commits but not this base branch is not
   * empty: that is a mistake to report, never a branch to invent.
   */
  async #beginBaseIfMissing(run: Run): Promise<void> {
    const { github } = this.#options;
    try {
      await github.getBranchSha(run.targetRepo, run.targetRepo.baseBranch);
      return;
    } catch (error) {
      if (isEmptyRepository(error)) return this.#beginBase(run);
      if (error instanceof GitHubApiError && error.status === 404)
        throw new Error(
          `${run.targetRepo.owner}/${run.targetRepo.name} has no branch "${run.targetRepo.baseBranch}" to open a pull request into, or the token cannot see it.`,
          { cause: error },
        );
      throw error;
    }
  }

  async #beginBase(run: Run): Promise<void> {
    const { pusher, repoDir } = this.#options;
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
  #pullRequestContent(
    run: Run,
    reason: DeliveryReason,
    commits: readonly string[],
  ): RunOutcome {
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
    const escalations = this.#options.escalations.listEscalations(run.id);
    // A Slice that passed and was sent back is not "passed" any more, yet its
    // Slice Commits are on the branch. They are the ones after the last
    // finished Slice's commit: Slices are built in order, so nothing else is.
    const lastFinished = Math.max(
      ...passed.map((slice) => commits.indexOf(slice.commitSha ?? "")),
      -1,
    );
    return {
      outcome: reason.ended,
      runId: run.id,
      requestTitle: run.projectRequest,
      summary,
      stopReason: stopReason(run, reason.ended, escalations),
      passedSlices: passed.map((slice) => slice.title),
      totalSlices: planned.length,
      failedSlice: unfinished
        ? {
            name: unfinished.title,
            issueReports: issueLines([
              ...(run.failure?.reports ?? []),
              ...escalations
                .filter((escalation) => escalation.slice === unfinished.title)
                .flatMap((escalation) => escalation.reports),
            ]),
            pushedCommits: commits.length - 1 - lastFinished,
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

/** What a person is told about an Escalation's trigger. */
const TRIGGER_TEXT: Record<EscalationTrigger, string> = {
  retryBudget: "the Retry Budget was spent",
  tokenBudget: "the Token Budget was spent",
  loop: "the same failure came back after a fix",
  undecidableOwner: "no agent could be blamed for the failure",
};

/**
 * Why the Run stopped. A failure says so itself; a Run aborted at an
 * Escalation is described by the last one (the one the abort answered), with
 * the Brief's account of what was failing when there is one.
 */
function stopReason(
  run: Run,
  ended: "aborted" | "failed",
  escalations: readonly Escalation[],
): string {
  if (run.failure) return run.failure.summary;
  // Only the Escalation a person answered with "abort" is where it stopped: an
  // earlier one that was retried, or one still open, is not.
  const last = escalations.at(-1);
  const atEscalation = ended === "aborted" && last?.choice === "abort";
  const where = last?.slice ? ` on "${last.slice}"` : "";
  const lines = [
    atEscalation
      ? `Aborted by a person at an Escalation${where}: ${TRIGGER_TEXT[last.trigger]}.`
      : ended === "aborted"
        ? "Aborted by a person."
        : "The Run failed.",
  ];
  const failing = atEscalation ? last.brief?.analysis?.failing : undefined;
  if (failing) lines.push(`What was failing: ${failing}`);
  if (escalations.length > 0)
    lines.push(
      `The Run was escalated ${escalations.length} time${escalations.length === 1 ? "" : "s"} in all.`,
    );
  return lines.join("\n\n");
}

/** Issue Reports as stored: only their text matters to a reader. */
function issueLines(reports: readonly unknown[]): string[] {
  const lines = reportLines(reports);
  // The same failure is reported at every attempt, and every Escalation.
  const unique = [...new Set(lines)];
  return unique.length > MAX_REPORTS
    ? [
        ...unique.slice(0, MAX_REPORTS),
        `…and ${unique.length - MAX_REPORTS} more`,
      ]
    : unique;
}

const MAX_REPORTS = 10;

function reportLines(reports: readonly unknown[]): string[] {
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

/** GitHub answers a repository with no commits at all with 409. */
function isEmptyRepository(error: unknown): boolean {
  return error instanceof GitHubApiError && error.status === 409;
}
