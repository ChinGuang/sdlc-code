/**
 * Builds one Slice (UML diagram 6): each side's Coding Agent writes in its own
 * Workspace at the same time, the Workspaces merge, the Testing Agent runs the
 * merged code, and it becomes a Slice Commit only when the Test Run passes.
 * A failure is routed by diagram 7 (T17a): only the owning side tries again,
 * with its Issue Reports, until the Slice passes or a limit escalates it.
 * What the Run does next (Escalation, document revision) is the caller's.
 */
import type { ExportedImage } from "@sdlc-code/clients";
import type { CodingSide, StackProfile } from "@sdlc-code/stack-profiles";
import type { TokenBudget } from "../agentLoop/agentLoop.js";
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
} from "./retryPolicy.js";

const ROLE: Record<CodingSide, "backendCoding" | "frontendCoding"> = {
  backend: "backendCoding",
  frontend: "frontendCoding",
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
  /** A person's hint after an Escalation ("retry with hint"), for every side. */
  hint?: string;
};

export type SliceOutcome =
  | { status: "passed"; commit: string; attempts: number }
  | {
      status: "escalated";
      trigger: EscalationTrigger;
      summary: string;
      reports: IssueReport[];
    }
  | {
      /** A design document is wrong: revise it before any more code (diagram 7). */
      status: "designIssue";
      revisions: Array<{
        owner: "systemDesign" | "uiDesign";
        reports: IssueReport[];
      }>;
    };

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
};

export class OrchestratedSliceRunner implements SliceRunner {
  #options: SliceRunnerOptions;

  constructor(options: SliceRunnerOptions) {
    this.#options = options;
  }

  runSlice = async (input: SliceRunInput): Promise<SliceOutcome> => {
    const { workspaces, testing, owners, slices, budget } = this.#options;
    const sides = codingSides(input.plan, input.documents.uiSpec);
    if (sides.length === 0)
      throw new Error(
        `Slice "${input.plan.title}" has nothing to build: no new endpoint and no screen.`,
      );
    const tasks = new Map(sides.map((side) => [side, this.#task(input, side)]));
    // Retries count from here: a person's hint after an Escalation grants a
    // fresh Retry Budget, while the Task keeps its total.
    const retriesBefore = new Map(
      sides.map((side) => [side, tasks.get(side)!.retries]),
    );
    const earlier = new Map<CodingSide, IssueReport[]>(
      sides.map((side) => [side, []]),
    );
    const context: OwnerContext = {
      documents: input.documents,
      slice: input.plan,
    };
    this.#move(input, "building");

    // Every side builds first; later, only the sides that own a failure.
    let pending = new Map<CodingSide, CodingIssue[]>(
      sides.map((side) => [side, hintIssues(input.hint)]),
    );
    for (let attempt = 1; ; attempt++) {
      if (budget.remaining() <= 0)
        return this.#escalate(
          input,
          "tokenBudget",
          "The Run's Token Budget is spent.",
          [],
        );
      const opened = await Promise.all(
        sides.map((side) => workspaces.openWorkspace(input.slice.id, side)),
      );
      await Promise.all(
        [...pending].map(([side, issues]) =>
          this.#code(input, side, tasks.get(side)!, opened, issues, attempt),
        ),
      );
      const merged = await workspaces.mergeSlice(input.slice.id, opened);
      if (merged.status === "conflict")
        return this.#escalate(
          input,
          "undecidableOwner",
          `The ${merged.role} Workspace conflicts with the other side in ${merged.files.join(", ")}.`,
          [],
        );

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
        return { status: "passed", commit, attempts: attempt };
      }

      const reports = tested.issueReports;
      const everyEarlier = [...earlier.values()].flat();
      const looping = detectLoop(reports, everyEarlier);
      if (looping)
        return this.#escalate(
          input,
          "loop",
          `The same failure came back after a fix: ${looping.failingTest ?? `${looping.step} step`}: ${looping.error}`,
          reports,
        );

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
        );
      if (route.kind === "reviseDocuments") {
        this.#move(input, "building");
        return {
          status: "designIssue",
          revisions: route.revisions.map(({ owner, reports: owned }) => ({
            owner,
            reports: owned.map(({ report }) => report),
          })),
        };
      }

      const next = new Map<CodingSide, CodingIssue[]>();
      for (const { owner, reports: owned } of route.retries) {
        const side: CodingSide =
          owner === "backendCoding" ? "backend" : "frontend";
        const task = tasks.get(side);
        const own = owned.map(({ report }) => report);
        // A side this Slice does not build cannot own a failure in it.
        if (!task)
          return this.#escalate(
            input,
            "undecidableOwner",
            `The ${side} owns a failure, but Slice "${input.plan.title}" has no ${side} Task.`,
            reports,
          );
        const decision = decideRetry({
          reports: own,
          earlier: earlier.get(side)!,
          retries: task.retries - retriesBefore.get(side)!,
          retryBudget: this.#options.retryBudget ?? DEFAULT_RETRY_BUDGET,
          tokensRemaining: budget.remaining(),
        });
        if (decision.action === "escalate")
          return this.#escalate(
            input,
            decision.trigger,
            decision.summary,
            reports,
          );
        tasks.set(side, this.#options.tasks.addRetry(task.id));
        earlier.get(side)!.push(...own);
        next.set(side, codingIssues(own));
      }
      this.#move(input, "building");
      pending = next;
    }
  };

  /** One Step of one side's Coding Agent, saved as its Workspace commit. */
  async #code(
    input: SliceRunInput,
    side: CodingSide,
    task: Task,
    opened: readonly Workspace[],
    issues: CodingIssue[],
    attempt: number,
  ): Promise<void> {
    const store = this.#options.tasks;
    const workspace = opened.find((candidate) => candidate.role === side)!;
    const step = store.startStep(task.id);
    const notes = store
      .listSteps(task.id)
      .filter((earlier) => earlier.status === "completed")
      .at(-1)?.workingMemory;
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
    store.completeStep(step.id, result.loop.workingMemory);
    await this.#options.workspaces.saveWorkspace(
      workspace,
      `${side}: ${input.plan.title} (attempt ${attempt})${result.summary ? `\n\n${result.summary}` : ""}`,
    );
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

  #escalate(
    input: SliceRunInput,
    trigger: EscalationTrigger,
    summary: string,
    reports: IssueReport[],
  ): SliceOutcome {
    // The Slice waits in "building": whatever a person decides starts from code.
    this.#move(input, "building");
    return { status: "escalated", trigger, summary, reports };
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
