/**
 * The Orchestrator (CONTEXT.md, UML diagrams 3, 5–7): steps a Run from its
 * Project Request to reviewing, stopping wherever a person decides.
 *
 *   designing          → Design Phase; the Design Gate opens (auto: approved)
 *   awaitingDesignGate → waits for decideDesign
 *   building           → each Slice in order (T17b); a design issue sends the
 *                        Run back to designing, a limit to an Escalation
 *                        (auto mode: the Run fails)
 *   escalated          → waits for resolveEscalation: retry with hint, edit
 *                        documents, skip the Slice, or abort
 *   reviewing onwards  → T19/T20
 *
 * What a later step needs from an earlier one (revisions to make, a Slice's
 * history, a hint) is kept here per Run; T18 moves it into Checkpoints.
 */
import type { ExportedImage } from "@sdlc-code/clients";
import type { CodingSide, StackProfile } from "@sdlc-code/stack-profiles";
import { documentOwner } from "../agentRoles.js";
import type { IssueReport } from "../agents/testing/issueReports.js";
import type { ModelCapabilities } from "../config/agentConfig.js";
import type { DocumentKind } from "../domain/documentLifecycle.js";
import type { Escalation, Run, Slice } from "../domain/entities.js";
import type { EscalationTrigger, RunStatus } from "../domain/runLifecycle.js";
import type { EscalationStore } from "../persistence/escalationStore.js";
import type { RunStore } from "../persistence/runStore.js";
import { NotFoundError } from "../persistence/storeOptions.js";
import type { DocumentStore } from "../persistence/documentStore.js";
import type { SliceStore } from "../persistence/sliceStore.js";
import type { TaskStore } from "../persistence/taskStore.js";
import { loadApprovedDocuments } from "./approvedDocuments.js";
import type {
  DesignGate,
  DesignVerdict,
  GateDecision,
  Revision,
} from "./designGate.js";
import type { DesignPhase } from "./designPhase.js";
import type { SliceHistory, SliceRunner } from "./sliceRunner.js";

/** Where a Run stopped, and why. */
export type RunProgress =
  | { waitingFor: "designGate" }
  | { waitingFor: "escalation"; escalation: Escalation }
  | { waitingFor: "codeReview" }
  | { waitingFor: "prGate" }
  | { finished: Extract<RunStatus, "done" | "failed" | "aborted"> };

export type EscalationResolution =
  | { choice: "retryWithHint"; hint: string }
  | {
      choice: "editDocuments";
      /** What to change in each document; its owning agent revises it. */
      edits: Array<{ documentKind: DocumentKind; comments: string }>;
    }
  | { choice: "skipSlice" }
  | { choice: "abort"; openDraftPrOnAbort?: boolean };

export interface RunOrchestrator {
  /** Runs until a person must decide or the Run leaves building. */
  advance: (runId: string) => Promise<RunProgress>;
  /** The human's Verdicts at the Design Gate; then call advance. */
  decideDesign: (runId: string, verdicts: DesignVerdict[]) => GateDecision;
  /** The human's choice at an Escalation; then call advance. */
  resolveEscalation: (runId: string, resolution: EscalationResolution) => void;
}

export type RunOrchestratorOptions = {
  runs: RunStore;
  documents: DocumentStore;
  slices: SliceStore;
  tasks: TaskStore;
  escalations: EscalationStore;
  gate: DesignGate;
  designPhase: DesignPhase;
  /** The Slice runner for a Run: its Workspaces, agents and budget. */
  sliceRunner: (run: Run) => Promise<SliceRunner>;
  profile: (run: Run) => StackProfile;
  capabilities: Record<CodingSide, ModelCapabilities>;
  penpotPage: (run: Run) => string | null;
};

/** What a Run carries from one step to the next (T18 persists it). */
type RunMemory = {
  revisions: Revision[];
  histories: Map<string, SliceHistory>;
  hints: Map<string, string>;
  screenImages: Map<string, ExportedImage>;
};

const REVISED_DOCUMENT: Record<"systemDesign" | "uiDesign", DocumentKind> = {
  // The API Contract lacks what the Slice Plan or a test needs.
  systemDesign: "apiContract",
  uiDesign: "uiSpec",
};

export class AgentRunOrchestrator implements RunOrchestrator {
  #options: RunOrchestratorOptions;
  #memory = new Map<string, RunMemory>();

  constructor(options: RunOrchestratorOptions) {
    this.#options = options;
  }

  advance = async (runId: string): Promise<RunProgress> => {
    for (;;) {
      const run = this.#run(runId);
      switch (run.status) {
        case "designing":
          await this.#design(run);
          continue;
        case "building":
          await this.#build(run);
          continue;
        case "awaitingDesignGate":
          return { waitingFor: "designGate" };
        case "escalated": {
          const escalation = this.#options.escalations.getOpenEscalation(runId);
          if (!escalation)
            throw new Error(
              `Run ${runId} is escalated but has no open Escalation.`,
            );
          return { waitingFor: "escalation", escalation };
        }
        case "reviewing":
          return { waitingFor: "codeReview" };
        case "awaitingPrGate":
          return { waitingFor: "prGate" };
        case "done":
        case "failed":
        case "aborted":
          return { finished: run.status };
      }
    }
  };

  decideDesign = (runId: string, verdicts: DesignVerdict[]): GateDecision => {
    const decision = this.#options.gate.decide(runId, verdicts);
    this.#memoryOf(runId).revisions.push(...decision.revisions);
    return decision;
  };

  resolveEscalation = (
    runId: string,
    resolution: EscalationResolution,
  ): void => {
    const { escalations, runs, slices, gate } = this.#options;
    const escalation = escalations.getOpenEscalation(runId);
    if (!escalation) throw new Error(`Run ${runId} has no open Escalation.`);
    // Check everything before changing anything.
    if (resolution.choice === "retryWithHint" && !resolution.hint.trim())
      throw new Error("A retry needs a hint for the Coding Agents.");
    if (
      resolution.choice === "editDocuments" &&
      resolution.edits.every((edit) => !edit.comments.trim())
    )
      throw new Error("Say what to change in at least one document.");
    const current = this.#currentSlice(runId);

    escalations.resolveEscalation(escalation.id, {
      choice: resolution.choice,
      hint: resolution.choice === "retryWithHint" ? resolution.hint : undefined,
      openDraftPrOnAbort:
        resolution.choice === "abort"
          ? (resolution.openDraftPrOnAbort ?? true)
          : undefined,
    });
    runs.applyEvent(runId, {
      type: "escalationResolved",
      choice: resolution.choice,
    });
    const memory = this.#memoryOf(runId);
    switch (resolution.choice) {
      case "retryWithHint":
        if (current) memory.hints.set(current.id, resolution.hint);
        return;
      case "skipSlice":
        if (current) {
          slices.moveSlice(current.id, "skipped");
          this.#closeTasks(runId, current.id, "failed");
        }
        return;
      case "editDocuments":
        for (const edit of resolution.edits.filter((e) => e.comments.trim())) {
          gate.documentChanged(runId, edit.documentKind);
          memory.revisions.push({
            agentRole: documentOwner(edit.documentKind),
            documentKind: edit.documentKind,
            comments: edit.comments,
          });
        }
        return;
      case "abort":
        if (current) this.#closeTasks(runId, current.id, "failed");
        return;
    }
  };

  async #design(run: Run): Promise<void> {
    const memory = this.#memoryOf(run.id);
    const result = await this.#options.designPhase.run(run, memory.revisions);
    memory.revisions = [];
    if (result.screenImages.size > 0) memory.screenImages = result.screenImages;
  }

  /** Builds Slices until the Run leaves building. */
  async #build(run: Run): Promise<void> {
    const { runs } = this.#options;
    const current = this.#currentSlice(run.id);
    if (!current) {
      runs.applyEvent(run.id, { type: "allSlicesCommitted" });
      return;
    }
    const documents = loadApprovedDocuments(this.#options.documents, run.id);
    const plan = documents.slicePlan.find(
      (planned) => planned.title === current.title,
    );
    if (!plan) {
      this.#limit(
        run,
        "undecidableOwner",
        `Slice "${current.title}" is no longer in the Slice Plan; decide whether to skip it.`,
        [],
      );
      return;
    }
    const memory = this.#memoryOf(run.id);
    const hint = memory.hints.get(current.id);
    memory.hints.delete(current.id);
    const runner = await this.#options.sliceRunner(run);
    const outcome = await runner.runSlice({
      runId: run.id,
      slice: current,
      plan,
      profile: this.#options.profile(run),
      projectRequest: run.projectRequest,
      documents,
      capabilities: this.#options.capabilities,
      screenImages: memory.screenImages,
      penpotPage: this.#options.penpotPage(run),
      history: memory.histories.get(current.id),
      hint,
    });
    switch (outcome.status) {
      case "passed":
        memory.histories.delete(current.id);
        return;
      case "escalated":
        memory.histories.set(current.id, outcome.history);
        this.#limit(run, outcome.trigger, outcome.summary, outcome.reports);
        return;
      case "designIssue":
        memory.histories.set(current.id, outcome.history);
        for (const { owner, reports } of outcome.revisions) {
          const kind = REVISED_DOCUMENT[owner];
          // Moves the Run back to designing, and makes dependants Stale.
          this.#options.gate.documentChanged(run.id, kind);
          memory.revisions.push({
            agentRole: owner,
            documentKind: kind,
            comments: reports
              .map(
                (report) =>
                  `${report.failingTest ?? `${report.step} step`}: ${report.error}`,
              )
              .join("\n"),
          });
        }
        return;
    }
  }

  /**
   * A limit stops the build: a person decides at an Escalation, or, with no
   * one to ask (auto mode), the Run fails and says why.
   */
  #limit(
    run: Run,
    trigger: EscalationTrigger,
    summary: string,
    reports: readonly IssueReport[],
  ): void {
    const { runs, escalations } = this.#options;
    const next = runs.applyEvent(run.id, { type: "limitHit", trigger });
    if (next.status === "escalated") {
      escalations.openEscalation(run.id, { trigger, summary });
      return;
    }
    const current = this.#currentSlice(run.id);
    if (current) this.#closeTasks(run.id, current.id, "failed");
    // The failure report the Draft PR will carry (T20).
    runs.saveCheckpoint(run.id, {
      reason: "Run failed",
      trigger,
      summary,
      slice: current?.title ?? null,
      reports,
    });
  }

  /** The first Slice that has not passed or been skipped, in plan order. */
  #currentSlice(runId: string): Slice | null {
    return (
      this.#options.slices
        .listSlices(runId)
        .find(
          (slice) => slice.status !== "passed" && slice.status !== "skipped",
        ) ?? null
    );
  }

  #closeTasks(runId: string, sliceId: string, status: "failed"): void {
    for (const task of this.#options.tasks.listTasks(runId))
      if (task.sliceId === sliceId && task.status === "running")
        this.#options.tasks.setTaskStatus(task.id, status);
  }

  #run(runId: string): Run {
    const run = this.#options.runs.getRun(runId);
    if (!run) throw new NotFoundError("Run", runId);
    return run;
  }

  #memoryOf(runId: string): RunMemory {
    let memory = this.#memory.get(runId);
    if (!memory) {
      memory = {
        revisions: [],
        histories: new Map(),
        hints: new Map(),
        screenImages: new Map(),
      };
      this.#memory.set(runId, memory);
    }
    return memory;
  }
}
