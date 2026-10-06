// SPDX-License-Identifier: MPL-2.0
/**
 * Builds one Slice (UML diagram 6): each side's Coding Agent writes in its own
 * Workspace at the same time, the Workspaces merge, the Testing Agent runs the
 * merged code, and it becomes a Slice Commit only when the Test Run passes.
 * A failure is routed by diagram 7 (T17a): only the owning side tries again,
 * with its Issue Reports, until the Slice passes or a limit escalates it.
 * What the Run does next (Escalation, document revision) is the caller's, and
 * so are the Tasks' final statuses when the Slice does not pass.
 */
import type { ExportedImage } from "@sdlc-code/clients";
import type { CodingSide, StackProfile } from "@sdlc-code/stack-profiles";
import {
  RunStoppedError,
  type StopReason,
  type TokenBudget,
} from "../agentLoop/agentLoop.js";
import type { CodingAgent } from "../agents/coding/codingAgent.js";
import {
  codingSides,
  type ApprovedDocuments,
  type CodingIssue,
} from "../agents/coding/codingContext.js";
import type { DesignSlice } from "../agents/systemDesign/design.js";
import {
  codingIssues,
  type IssueReport,
} from "../agents/testing/issueReports.js";
import type { TestingAgent } from "../agents/testing/testingAgent.js";
import type { ModelCapabilities } from "../config/agentConfig.js";
import type { Slice, Task } from "../domain/entities.js";
import type { EscalationTrigger } from "../domain/runLifecycle.js";
import type { SliceStore } from "../persistence/sliceStore.js";
import type { TaskStore } from "../persistence/taskStore.js";
import type {
  PassedTestRun,
  Workspace,
  WorkspaceManager,
} from "../workspaces/workspaceManager.js";
import { Mutex } from "../mutex.js";
import { routeIssues, type RoutedReport } from "./issueRouting.js";
import type { OwnerContext, OwnerResolver } from "./ownerResolution.js";
import {
  decideRetry,
  detectLoop,
  DEFAULT_RETRY_BUDGET,
  type RetryDecision,
} from "./retryPolicy.js";

const ROLE: Record<CodingSide, "backendCoding" | "frontendCoding"> = {
  backend: "backendCoding",
  frontend: "frontendCoding",
};
const SIDE_OF: Record<"backendCoding" | "frontendCoding", CodingSide> = {
  backendCoding: "backend",
  frontendCoding: "frontend",
};

/**
 * What the Slice has been through, carried across `runSlice` calls (after a
 * document revision, an Escalation, a restart) so a Loop is still a Loop and
 * the Retry Budget is not refilled for free. T18 stores it in the Checkpoint.
 */
export type SliceHistory = {
  /** Issue Reports routed to each side's Task, and to design agents. */
  earlier: Record<CodingSide | "design", IssueReport[]>;
  /** Each Task's retries when its current Retry Budget began. */
  retryBaseline: Partial<Record<CodingSide, number>>;
  /**
   * The sides coding on the attempt under way, and what each was told: a
   * Slice picked up after a restart goes on with exactly that attempt, not a
   * wider one (T24i). Only while the Slice runs; none once it returns.
   */
  pending?: Partial<Record<CodingSide, CodingIssue[]>>;
};

/** Something to fix on the next attempt, and who asked for it. */
export type SliceHint = {
  from: "person" | "codeReview";
  issues: readonly CodingIssue[];
  /**
   * The sides it is for (T24i): only they code on the next attempt, while
   * the other side's saved code is merged and tested as it is. Absent, every
   * side of the Slice is.
   */
  sides?: readonly CodingSide[];
};

export type SliceRunInput = {
  runId: string;
  /** The stored Slice (its id and status) … */
  slice: Slice;
  /** … and what the Slice Plan says it builds. */
  plan: DesignSlice;
  profile: StackProfile;
  projectRequest: string;
  documents: ApprovedDocuments;
  capabilities: Record<CodingSide, ModelCapabilities>;
  /** The Design Phase's board exports, by screen name. */
  screenImages: ReadonlyMap<string, ExportedImage>;
  /** The Run's Penpot page; null without one. */
  penpotPage: string | null;
  /** From the previous outcome of this Slice; absent on its first run. */
  history?: SliceHistory;
  /**
   * What this attempt is told to fix first, from an Escalation, the PR Gate or
   * the Code Review Agent, for every side. It refills the Retry Budget: a
   * person or a review asked for another attempt.
   */
  hint?: SliceHint;
};

export type SliceOutcome =
  | { status: "passed"; commit: string; attempts: number }
  | {
      status: "escalated";
      trigger: EscalationTrigger;
      summary: string;
      reports: IssueReport[];
      history: SliceHistory;
    }
  | {
      /** A design document is wrong: revise it before any more code (diagram 7). */
      status: "designIssue";
      revisions: Array<{
        owner: "systemDesign" | "uiDesign";
        reports: IssueReport[];
      }>;
      history: SliceHistory;
    };

/**
 * A point where diagram 6 saves a Checkpoint. The Orchestrator writes one from
 * it: "retrying" carries the history a resumed Slice must keep, or its Retry
 * Budget would be refilled and a repeated failure would no longer be a Loop.
 */
export type SliceCheckpoint =
  | { at: "merged"; sliceId: string; attempt: number; commit: string }
  | { at: "committed"; sliceId: string; commit: string }
  | { at: "retrying"; sliceId: string; attempt: number; history: SliceHistory };

export interface SliceRunner {
  runSlice: (input: SliceRunInput) => Promise<SliceOutcome>;
}

export type SliceRunnerOptions = {
  workspaces: WorkspaceManager;
  testing: TestingAgent;
  owners: OwnerResolver;
  tasks: TaskStore;
  slices: SliceStore;
  budget: TokenBudget;
  /** A Coding Agent for one Step, recording its Transcript under `stepId`. */
  codingAgent: (side: CodingSide, stepId: string) => CodingAgent;
  retryBudget?: number;
  checkpoint?: (checkpoint: SliceCheckpoint) => void;
  /**
   * Whether a person stopped the Run (T24g): asked before a merge, a Test
   * Run and a commit, so nothing new starts after an abort.
   */
  stopped?: () => boolean;
};

/** How one side's Step ended. */
type Coded =
  | { side: CodingSide; outcome: "changed" | "unchanged" }
  | { side: CodingSide; outcome: "stopped"; reason: StopReason };

const STOPPED: Partial<Record<StopReason, string>> = {
  maxIterations: "ran out of turns",
  emptyAnswer: "gave an empty answer",
  apiError: "hit a Token Factory error",
};

export class OrchestratedSliceRunner implements SliceRunner {
  #options: SliceRunnerOptions;
  /**
   * Slices built at the same time (S5) take turns at what changes the run
   * branch: each is merged, tested and committed on top of what the others
   * already committed. Coding, the long part, is not behind it.
   */
  #integration = new Mutex();
  /** Opening worktrees changes the shared repository; one at a time is safe. */
  #opening = new Mutex();

  constructor(options: SliceRunnerOptions) {
    this.#options = options;
  }

  #stopIfAborted(): void {
    if (this.#options.stopped?.()) throw new RunStoppedError();
  }

  runSlice = async (input: SliceRunInput): Promise<SliceOutcome> => {
    const { workspaces, testing, owners, slices, budget } = this.#options;
    if (!["pending", "building", "testing"].includes(input.slice.status))
      throw new Error(
        `Slice "${input.plan.title}" is ${input.slice.status}; there is nothing left to build.`,
      );
    const sides = codingSides(input.plan, input.documents.uiSpec);
    if (sides.length === 0)
      throw new Error(
        `Slice "${input.plan.title}" has nothing to build: no new endpoint and no screen.`,
      );
    const tasks = new Map(sides.map((side) => [side, this.#task(input, side)]));
    const history: SliceHistory = {
      earlier: {
        backend: [...(input.history?.earlier.backend ?? [])],
        frontend: [...(input.history?.earlier.frontend ?? [])],
        design: [...(input.history?.earlier.design ?? [])],
      },
      retryBaseline: Object.fromEntries(
        sides.map((side) => [
          side,
          input.hint !== undefined
            ? tasks.get(side)!.retries
            : (input.history?.retryBaseline[side] ?? tasks.get(side)!.retries),
        ]),
      ),
    };
    const context: OwnerContext = {
      documents: input.documents,
      slice: input.plan,
    };
    this.#move(input, "building");

    // Every side builds first; later, only the sides that own a failure. A
    // Slice picked up again with no hint (a restart mid-retry) is told what
    // it failed on: its saved code is kept now (T24h), and an agent told
    // nothing would hand it back unchanged and fail the same way.
    let pending = this.#firstAttempt(input, sides, tasks, history);
    let lastReports: IssueReport[] = [];
    for (let attempt = 1; ; attempt++) {
      if (budget.remaining() <= 0)
        return this.#escalate(
          input,
          "tokenBudget",
          "The Run's Token Budget is spent.",
          [],
          history,
        );
      const opened = await this.#opening.run(() =>
        Promise.all(
          sides.map((side) => workspaces.openWorkspace(input.slice.id, side)),
        ),
      );
      // Every Step ends before anything else happens, even if one throws, so
      // no Step is left running behind the caller's back.
      const settled = await Promise.allSettled(
        [...pending].map(([side, issues]) =>
          this.#code(input, side, tasks.get(side)!, opened, issues, attempt),
        ),
      );
      const failed = settled.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      const coded = settled.map(
        (result) => (result as PromiseFulfilledResult<Coded>).value,
      );

      const stopped = coded.filter(
        (step): step is Extract<Coded, { outcome: "stopped" }> =>
          step.outcome === "stopped",
      );
      if (stopped.some((step) => step.reason === "tokenBudget"))
        return this.#escalate(
          input,
          "tokenBudget",
          "The Run's Token Budget is spent.",
          [],
          history,
        );
      if (stopped.length > 0) {
        // A side that stopped part-way redoes its Step; nothing is tested.
        const decisions = stopped.map((step) => ({
          side: step.side,
          decision: this.#decide(step.side, [], tasks, history),
          issues: [
            {
              summary: `Your previous attempt ${STOPPED[step.reason] ?? "stopped"} before finishing; its changes were discarded.`,
              evidence:
                "Start again, and finish with a short summary once the Slice is built.",
            },
          ],
        }));
        const escalation = decisions.find(
          ({ decision }) => decision.action === "escalate",
        );
        if (escalation?.decision.action === "escalate")
          return this.#escalate(
            input,
            escalation.decision.trigger,
            escalation.decision.summary,
            [],
            history,
          );
        pending = this.#retry(decisions, tasks);
        continue;
      }
      if (
        lastReports.length > 0 &&
        coded.every((step) => step.outcome === "unchanged")
      )
        // Testing the same code again would only fail the same way. Only
        // once a Test Run has failed: after an attempt that stopped before
        // testing, unchanged code has not failed yet (found in T25).
        return this.#escalate(
          input,
          "loop",
          "The Coding Agents answered without changing anything, so the failure stands.",
          lastReports,
          history,
        );

      this.#stopIfAborted();
      const release = await this.#integration.acquire();
      let tested: Awaited<ReturnType<TestingAgent["testSlice"]>>;
      try {
        const merged = await workspaces.mergeSlice(input.slice.id, opened);
        if (merged.status === "conflict") {
          // Not the other side's doing but a peer Slice's, committed while this
          // one was coding: start again on top of it, which costs a retry.
          if (await workspaces.isBehind(input.slice.id)) {
            await workspaces.discardSlice(input.slice.id);
            const decisions = sides.map((side) => ({
              side,
              decision: this.#decide(side, [], tasks, history),
              issues: [
                {
                  summary: `Another Slice was committed while you worked, and your changes conflict with it in ${merged.files.join(", ")}. Your Workspace was reset to the code as it is now: build this Slice again on top of it, and keep what the other Slice added.`,
                  evidence:
                    "Read the files named, then add this Slice's changes beside the existing ones.",
                },
              ],
            }));
            const escalation = decisions.find(
              ({ decision }) => decision.action === "escalate",
            );
            if (escalation?.decision.action === "escalate")
              return this.#escalate(
                input,
                escalation.decision.trigger,
                // Not "the agents did not finish": they kept meeting a peer's work.
                `Slice "${input.plan.title}" kept conflicting with a Slice committed beside it, in ${merged.files.join(", ")}.`,
                [],
                history,
              );
            pending = this.#retry(decisions, tasks);
            // Written down as a retry is: the Workspaces are gone, so every
            // side codes again, and a restart must know it.
            history.pending = Object.fromEntries(pending);
            this.#options.checkpoint?.({
              at: "retrying",
              sliceId: input.slice.id,
              attempt,
              history,
            });
            continue;
          }
          return this.#escalate(
            input,
            "undecidableOwner",
            `The ${merged.role} Workspace conflicts with the other side in ${merged.files.join(", ")}.`,
            [],
            history,
          );
        }
        this.#options.checkpoint?.({
          at: "merged",
          sliceId: input.slice.id,
          attempt,
          commit: merged.commit,
        });

        this.#stopIfAborted();
        this.#move(input, "testing");
        tested = await testing.testSlice({
          profile: input.profile,
          files: await workspaces.readFiles(merged.commit),
        });
        if (tested.testRun.status === "passed") {
          // A Slice that passed after the abort is not committed to its Run.
          this.#stopIfAborted();
          const commit = await workspaces.commitSlice(
            merged,
            // Checked just above; the union does not narrow on its own.
            tested.testRun as PassedTestRun,
            `Slice ${input.slice.order}: ${input.plan.title}`,
          );
          slices.moveSlice(input.slice.id, "passed", commit);
          for (const task of tasks.values())
            this.#options.tasks.setTaskStatus(task.id, "done");
          this.#options.checkpoint?.({
            at: "committed",
            sliceId: input.slice.id,
            commit,
          });
          return { status: "passed", commit, attempts: attempt };
        }
      } finally {
        release();
      }

      const reports = tested.issueReports;
      lastReports = reports;
      const routed: RoutedReport[] = await Promise.all(
        reports.map(async (report) => ({
          report,
          decision: await owners.resolve(report, context),
        })),
      );
      const route = routeIssues(routed);
      if (route.kind === "escalate")
        return this.#escalate(
          input,
          "undecidableOwner",
          route.summary,
          reports,
          history,
        );
      if (route.kind === "reviseDocuments") {
        const revised = route.revisions.flatMap(({ reports: owned }) =>
          owned.map(({ report }) => report),
        );
        // A revision that did not help is a Loop too (diagram 7 asks first).
        const looping = detectLoop(revised, history.earlier.design);
        if (looping)
          return this.#escalate(
            input,
            "loop",
            `The same failure came back after the documents were revised: ${looping.failingTest ?? `${looping.step} step`}: ${looping.error}`,
            reports,
            history,
          );
        history.earlier.design.push(...revised);
        this.#move(input, "building");
        delete history.pending;
        return {
          status: "designIssue",
          revisions: route.revisions.map(({ owner, reports: owned }) => ({
            owner,
            reports: owned.map(({ report }) => report),
          })),
          history,
        };
      }

      // Decide for every owning side before recording any retry, so an
      // Escalation leaves no retry counted for an attempt that never ran.
      const decisions: Array<{
        side: CodingSide;
        decision: RetryDecision;
        issues: CodingIssue[];
        reports: IssueReport[];
      }> = [];
      for (const { owner, reports: owned } of route.retries) {
        const side = SIDE_OF[owner];
        const own = owned.map(({ report }) => report);
        // A side this Slice does not build cannot own a failure in it.
        if (!tasks.has(side))
          return this.#escalate(
            input,
            "undecidableOwner",
            `The ${side} owns a failure, but Slice "${input.plan.title}" has no ${side} Task.`,
            reports,
            history,
          );
        decisions.push({
          side,
          decision: this.#decide(side, own, tasks, history),
          issues: codingIssues(own),
          reports: own,
        });
      }
      const escalation = decisions.find(
        ({ decision }) => decision.action === "escalate",
      );
      if (escalation?.decision.action === "escalate")
        return this.#escalate(
          input,
          escalation.decision.trigger,
          escalation.decision.summary,
          reports,
          history,
        );
      // A Loop is the same failure in the same Task, so history is per side.
      for (const { side, reports: own } of decisions)
        history.earlier[side].push(...own);
      pending = this.#retry(decisions, tasks);
      this.#move(input, "building");
      history.pending = Object.fromEntries(pending);
      this.#options.checkpoint?.({
        at: "retrying",
        sliceId: input.slice.id,
        attempt,
        history,
      });
    }
  };

  #decide(
    side: CodingSide,
    reports: IssueReport[],
    tasks: Map<CodingSide, Task>,
    history: SliceHistory,
  ): RetryDecision {
    const task = tasks.get(side)!;
    return decideRetry({
      reports,
      earlier: history.earlier[side],
      retries: task.retries - (history.retryBaseline[side] ?? task.retries),
      retryBudget: this.#options.retryBudget ?? DEFAULT_RETRY_BUDGET,
      tokensRemaining: this.#options.budget.remaining(),
    });
  }

  /** Records a retry for each side, and what each is told to fix. */
  #retry(
    decisions: ReadonlyArray<{ side: CodingSide; issues: CodingIssue[] }>,
    tasks: Map<CodingSide, Task>,
  ): Map<CodingSide, CodingIssue[]> {
    const next = new Map<CodingSide, CodingIssue[]>();
    for (const { side, issues } of decisions) {
      tasks.set(side, this.#options.tasks.addRetry(tasks.get(side)!.id));
      next.set(side, issues);
    }
    return next;
  }

  /** One Step of one side's Coding Agent, saved as its Workspace commit. */
  async #code(
    input: SliceRunInput,
    side: CodingSide,
    task: Task,
    opened: readonly Workspace[],
    issues: CodingIssue[],
    attempt: number,
  ): Promise<Coded> {
    const store = this.#options.tasks;
    const workspace = opened.find((candidate) => candidate.role === side)!;
    const notes = store
      .listSteps(task.id)
      .filter((earlier) => earlier.status === "completed")
      .at(-1)?.workingMemory;
    const step = store.startStep(task.id);
    let result;
    try {
      result = await this.#options.codingAgent(side, step.id).code({
        side,
        profile: input.profile,
        projectRequest: input.projectRequest,
        slice: input.plan,
        documents: input.documents,
        issueReports: issues,
        workingMemory: notes ?? null,
        capabilities: input.capabilities[side],
        screenImages: input.screenImages,
        workspaceDir: workspace.dir,
        penpotPage: input.penpotPage,
      });
    } catch (error) {
      // An interrupted Step is redone, never resumed (CONTEXT.md "Step").
      store.discardStep(step.id);
      await this.#options.workspaces.resetWorkspace(workspace);
      throw error;
    }
    // An agent that ran out of turns has usually written working code; the
    // Test Run judges it, rather than the turn counter throwing it away. Only
    // a Step with nothing to keep is discarded and redone.
    if (result.problem === "notAnswered" && result.changes.length === 0) {
      store.discardStep(step.id);
      await this.#options.workspaces.resetWorkspace(workspace);
      return { side, outcome: "stopped", reason: result.loop.stopReason };
    }
    // Saved before the Step is marked complete: a process that dies between
    // the two leaves a discarded Step whose code is kept, never a completed
    // Step whose code a restart throws away (T24h).
    if (result.problem === "notAnswered") {
      await this.#options.workspaces.saveWorkspace(
        workspace,
        `${side}: ${input.plan.title} (attempt ${attempt}, unfinished: ${STOPPED[result.loop.stopReason] ?? result.loop.stopReason})`,
      );
      store.completeStep(step.id, result.loop.workingMemory);
      // The Token Budget is the one stop no attempt can recover from.
      return result.loop.stopReason === "tokenBudget"
        ? { side, outcome: "stopped", reason: "tokenBudget" }
        : { side, outcome: "changed" };
    }
    const saved = await this.#options.workspaces.saveWorkspace(
      workspace,
      `${side}: ${input.plan.title} (attempt ${attempt})${result.summary ? `\n\n${result.summary}` : ""}`,
    );
    store.completeStep(step.id, result.loop.workingMemory);
    return { side, outcome: saved ? "changed" : "unchanged" };
  }

  /**
   * Who codes on the first attempt of this call, and what each is told:
   * - with a hint, the sides it names (T24i), each told the hint; a side
   *   that never built anything in this Slice codes too, told nothing of a
   *   hint that is not for it;
   * - picked up after a restart, the attempt under way, as the last
   *   Checkpoint recorded it (and a side that never built anything);
   * - otherwise every side, told what it failed on before (T24h).
   */
  #firstAttempt(
    input: SliceRunInput,
    sides: readonly CodingSide[],
    tasks: ReadonlyMap<CodingSide, Task>,
    history: SliceHistory,
  ): Map<CodingSide, CodingIssue[]> {
    const { hint } = input;
    if (hint) {
      const named = hint.sides?.filter((side) => tasks.has(side)) ?? [];
      const forIt = (side: CodingSide) =>
        named.length === 0 || named.includes(side);
      return new Map(
        sides
          .filter((side) => forIt(side) || !this.#hasBuilt(tasks.get(side)!))
          .map((side) => [side, forIt(side) ? hintIssues(hint) : []]),
      );
    }
    const resumed = input.history?.pending;
    if (resumed && sides.some((side) => resumed[side] !== undefined))
      return new Map(
        sides
          .filter(
            (side) =>
              resumed[side] !== undefined || !this.#hasBuilt(tasks.get(side)!),
          )
          .map((side) => [side, [...(resumed[side] ?? [])]]),
      );
    return new Map(
      sides.map((side) => [
        side,
        codingIssues(latestOf(history.earlier[side])),
      ]),
    );
  }

  /** Whether a side completed a Step in this Slice, so has code to merge. */
  #hasBuilt(task: Task): boolean {
    return this.#options.tasks
      .listSteps(task.id)
      .some((step) => step.status === "completed");
  }

  /** The side's Task in this Slice, created the first time it is needed. */
  #task(input: SliceRunInput, side: CodingSide): Task {
    const existing = this.#options.tasks
      .listTasks(input.runId)
      .find(
        (task) =>
          task.sliceId === input.slice.id && task.agentRole === ROLE[side],
      );
    const task =
      existing ??
      this.#options.tasks.createTask({
        runId: input.runId,
        sliceId: input.slice.id,
        agentRole: ROLE[side],
      });
    return task.status === "running"
      ? task
      : this.#options.tasks.setTaskStatus(task.id, "running");
  }

  /**
   * The Slice waits in "building", since whatever a person decides starts
   * from code; its Tasks stay "running" until the caller settles the Run.
   */
  #escalate(
    input: SliceRunInput,
    trigger: EscalationTrigger,
    summary: string,
    reports: IssueReport[],
    history: SliceHistory,
  ): SliceOutcome {
    this.#move(input, "building");
    delete history.pending;
    return { status: "escalated", trigger, summary, reports, history };
  }

  /** Moves the Slice, unless it is already there. */
  #move(input: SliceRunInput, to: "building" | "testing"): void {
    const slice = this.#options.slices
      .listSlices(input.runId)
      .find((candidate) => candidate.id === input.slice.id);
    if (slice && slice.status !== to)
      this.#options.slices.moveSlice(input.slice.id, to);
  }
}

/**
 * A hint, given to every side as the first thing to address. Who it came from is
 * part of it: a Coding Agent reading "a person says" about a machine's Finding
 * would be told something untrue about its own Task.
 */
/**
 * Each failure once, its latest report first: what a side failed on
 * before, kept in order of attempt (SliceHistory.earlier).
 */
function latestOf(reports: readonly IssueReport[]): IssueReport[] {
  const seen = new Set<string>();
  return [...reports].reverse().filter((report) => {
    if (seen.has(report.signature)) return false;
    seen.add(report.signature);
    return true;
  });
}

function hintIssues(hint: SliceHint | undefined): CodingIssue[] {
  if (!hint) return [];
  return hint.issues.map((issue) => ({
    summary: `${HINT_FROM[hint.from]} ${issue.summary}`,
    evidence: issue.evidence,
  }));
}

const HINT_FROM: Record<SliceHint["from"], string> = {
  person: "A person reviewed the last attempt and says:",
  codeReview: "The Code Review Agent refused this Slice:",
};
