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
import type { StopReason, TokenBudget } from "../agentLoop/agentLoop.js";
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
   * A person's hint after an Escalation ("retry with hint"), for every side.
   * It refills the Retry Budget: a person chose to try again.
   */
  hint?: string;
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

/** A point where diagram 6 saves a Checkpoint; T18 writes it. */
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

  constructor(options: SliceRunnerOptions) {
    this.#options = options;
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

    // Every side builds first; later, only the sides that own a failure.
    let pending = new Map<CodingSide, CodingIssue[]>(
      sides.map((side) => [side, hintIssues(input.hint)]),
    );
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
      const opened = await Promise.all(
        sides.map((side) => workspaces.openWorkspace(input.slice.id, side)),
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
      if (attempt > 1 && coded.every((step) => step.outcome === "unchanged"))
        // Testing the same code again would only fail the same way.
        return this.#escalate(
          input,
          "loop",
          "The Coding Agents answered without changing anything, so the failure stands.",
          lastReports,
          history,
        );

      const merged = await workspaces.mergeSlice(input.slice.id, opened);
      if (merged.status === "conflict")
        return this.#escalate(
          input,
          "undecidableOwner",
          `The ${merged.role} Workspace conflicts with the other side in ${merged.files.join(", ")}.`,
          [],
          history,
        );
      this.#options.checkpoint?.({
        at: "merged",
        sliceId: input.slice.id,
        attempt,
        commit: merged.commit,
      });

      this.#move(input, "testing");
      const tested = await testing.testSlice({
        profile: input.profile,
        files: await workspaces.readFiles(merged.commit),
      });
      if (tested.testRun.status === "passed") {
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
    if (result.problem === "notAnswered") {
      store.discardStep(step.id);
      await this.#options.workspaces.resetWorkspace(workspace);
      return { side, outcome: "stopped", reason: result.loop.stopReason };
    }
    store.completeStep(step.id, result.loop.workingMemory);
    const saved = await this.#options.workspaces.saveWorkspace(
      workspace,
      `${side}: ${input.plan.title} (attempt ${attempt})${result.summary ? `\n\n${result.summary}` : ""}`,
    );
    return { side, outcome: saved ? "changed" : "unchanged" };
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

/** A person's hint, given to every side as the first thing to address. */
function hintIssues(hint: string | undefined): CodingIssue[] {
  return hint
    ? [
        {
          summary: "A person reviewed the last failure and says:",
          evidence: hint,
        },
      ]
    : [];
}
