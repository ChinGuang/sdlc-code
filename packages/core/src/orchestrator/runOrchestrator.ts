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
 *   reviewing          → the Slices are built: the run branch is pushed and a
 *                        pull request opened (T20; T19's review comes first
 *                        once it exists), then the PR Gate opens (auto: done)
 *   awaitingPrGate     → waits for decidePullRequest
 *
 * What a later step needs from an earlier one (revisions to make, a Slice's
 * history, a hint) is written to a Checkpoint at every Step boundary
 * (runCheckpoint.ts), so a Run that stopped continues where it was. The board
 * PNGs are the exception: a resumed Run works from the UI Spec without them.
 */
import type { ExportedImage } from "@sdlc-code/clients";
import type { CodingSide, StackProfile } from "@sdlc-code/stack-profiles";
import { documentOwner } from "../agentRoles.js";
import type { IssueReport } from "../agents/testing/issueReports.js";
import type { ModelCapabilities } from "../config/agentConfig.js";
import type { DocumentKind } from "../domain/documentLifecycle.js";
import type {
  Escalation,
  Run,
  RunPullRequest,
  Slice,
} from "../domain/entities.js";
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
import { DesignPhaseError, type DesignPhase } from "./designPhase.js";
import {
  checkpointPayload,
  memoryFromCheckpoint,
  type RunMemoryState,
} from "./runCheckpoint.js";
import type { SliceCheckpoint, SliceRunner } from "./sliceRunner.js";
import type { DeliveryReason, RunDelivery } from "../delivery/runDelivery.js";
import type { GateStore } from "../persistence/gateStore.js";

/** Where a Run stopped, and why. */
export type RunProgress =
  | { waitingFor: "designGate" }
  | { waitingFor: "escalation"; escalation: Escalation }
  | { waitingFor: "codeReview" }
  | { waitingFor: "prGate"; pullRequest: RunPullRequest | null }
  | { finished: Extract<RunStatus, "done" | "failed" | "aborted"> };

/** The human's decision at the PR Gate (diagram 8). */
export type PullRequestDecision =
  { choice: "approve" } | { choice: "requestChanges"; comments: string };

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
  /** The human's decision at the PR Gate; then call advance. */
  decidePullRequest: (runId: string, decision: PullRequestDecision) => void;
}

export type RunOrchestratorOptions = {
  runs: RunStore;
  documents: DocumentStore;
  slices: SliceStore;
  tasks: TaskStore;
  escalations: EscalationStore;
  gates: GateStore;
  gate: DesignGate;
  /** Pushes the run branch and opens the pull request (T20). */
  delivery: RunDelivery;
  designPhase: DesignPhase;
  /**
   * The Slice runner for a Run: its Workspaces, agents and budget. It reports
   * each Checkpoint of diagram 6 to `onCheckpoint`, which writes it down.
   */
  sliceRunner: (
    run: Run,
    onCheckpoint: (checkpoint: SliceCheckpoint) => void,
  ) => Promise<SliceRunner>;
  profile: (run: Run) => StackProfile;
  capabilities: Record<CodingSide, ModelCapabilities>;
  penpotPage: (run: Run) => string | null;
};

/** What a Run carries from one step to the next. */
type RunMemory = RunMemoryState & {
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
  /**
   * A Draft PR a stopped Run still owes (diagram 3b). Deciding is a person's
   * answer and must not wait for a push, so advance does the pushing.
   */
  #pendingDelivery = new Map<string, DeliveryReason>();

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
          await this.#review(run);
          continue;
        case "awaitingPrGate":
          return { waitingFor: "prGate", pullRequest: run.pullRequest };
        case "done":
        case "failed":
        case "aborted":
          await this.#deliverIfOwed(run);
          return { finished: run.status };
      }
    }
  };

  decideDesign = (runId: string, verdicts: DesignVerdict[]): GateDecision => {
    const decision = this.#options.gate.decide(runId, verdicts);
    this.#memoryOf(runId).revisions.push(...decision.revisions);
    this.#checkpoint(runId);
    return decision;
  };

  resolveEscalation = (
    runId: string,
    resolution: EscalationResolution,
  ): void => {
    const { escalations, runs, slices } = this.#options;
    const escalation = escalations.getOpenEscalation(runId);
    if (!escalation) throw new Error(`Run ${runId} has no open Escalation.`);
    // Check everything before changing anything.
    if (resolution.choice === "retryWithHint" && !resolution.hint.trim())
      throw new Error("A retry needs a hint for the Coding Agents.");
    const edits =
      resolution.choice === "editDocuments"
        ? this.#editsToMake(runId, resolution.edits)
        : [];
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
        break;
      case "skipSlice":
        if (current) {
          slices.moveSlice(current.id, "skipped");
          this.#failTasks(runId, current.id);
        }
        break;
      case "editDocuments":
        for (const edit of edits) this.#reopen(runId, edit);
        break;
      case "abort":
        if (current) this.#failTasks(runId, current.id);
        // Diagram 3b: the passed Slices still reach the Target Repo, unless the
        // person untied the checkbox. Awaited by advance, not here, because
        // resolveEscalation answers the person at once.
        this.#pendingDelivery.set(runId, {
          ended: "aborted",
          // What the person ticked in this dialog, not the Escalation's default.
          openDraftPr: resolution.openDraftPrOnAbort ?? true,
        });
        break;
    }
    // The person's decision is the thing a resumed Run must not lose.
    this.#checkpoint(runId);
  };

  decidePullRequest = (runId: string, decision: PullRequestDecision): void => {
    const { runs, gates, slices } = this.#options;
    if (decision.choice === "requestChanges" && !decision.comments.trim())
      throw new Error("Say what to change, or approve the pull request.");
    const gate = gates.getOpenGate(runId);
    if (!gate || gate.kind !== "pr")
      throw new Error(`Run ${runId} has no open PR Gate.`);
    gates.recordVerdict(gate.id, {
      // A PR Gate judges the whole pull request, not one document.
      documentId: null,
      decision: decision.choice === "approve" ? "approve" : "requestChanges",
      comments: decision.choice === "approve" ? "" : decision.comments,
    });
    gates.closeGate(
      gate.id,
      decision.choice === "approve" ? "passed" : "changesRequested",
    );
    runs.applyEvent(runId, {
      type: decision.choice === "approve" ? "prApproved" : "prChangesRequested",
    });
    if (decision.choice === "approve") return;
    // Diagram 8: the changes are a fix Task, so the last Slice is built again
    // with the comments as its hint. Its Slice Commit stays until a new one
    // replaces it.
    const last = slices
      .listSlices(runId)
      .filter((slice) => slice.status === "passed")
      .at(-1);
    if (last) {
      slices.moveSlice(last.id, "building");
      this.#memoryOf(runId).hints.set(last.id, decision.comments);
    }
    this.#checkpoint(runId);
  };

  /**
   * The Slices are built and tested: push the run branch and open the pull
   * request. T19's Code Review comes before this once it exists, which is why
   * the pull request carries no Findings yet.
   */
  async #review(run: Run): Promise<void> {
    const { runs, gates, delivery } = this.#options;
    const outcome = await delivery.deliver(run.id, {
      ended: "complete",
      findings: [],
    });
    // A Run whose every Slice was skipped finished its plan with nothing to
    // push, so there is no pull request and no Gate to hold it at.
    if (outcome.status === "keptLocal") {
      runs.applyEvent(run.id, { type: "nothingToDeliver" });
      return;
    }
    const next = runs.applyEvent(run.id, { type: "prOpened" });
    if (next.status === "awaitingPrGate") gates.openGate(run.id, "pr");
  }

  /**
   * A person's document edits, checked before anything changes: one Revision
   * per document, and only the text documents (the Penpot design follows the
   * UI Spec).
   */
  #editsToMake(
    runId: string,
    edits: ReadonlyArray<{ documentKind: DocumentKind; comments: string }>,
  ): Revision[] {
    const byKind = new Map<DocumentKind, string[]>();
    for (const { documentKind, comments } of edits) {
      if (!comments.trim()) continue;
      if (documentKind === "penpotDesign")
        throw new Error(
          "Edit the UI Spec instead; the Penpot design is redrawn from it.",
        );
      if (!this.#options.documents.getLatest(runId, documentKind))
        throw new Error(`Run ${runId} has no ${documentKind} to edit.`);
      byKind.set(documentKind, [
        ...(byKind.get(documentKind) ?? []),
        comments.trim(),
      ]);
    }
    if (byKind.size === 0)
      throw new Error("Say what to change in at least one document.");
    return [...byKind].map(([documentKind, comments]) => ({
      agentRole: documentOwner(documentKind),
      documentKind,
      comments: comments.join("\n"),
    }));
  }

  /**
   * Sends a document back to its owner. An Approved Document goes back to
   * drafting, which makes the documents built on it Stale; one already Stale
   * or sent back is revised as it is. Either way the Run goes to designing.
   */
  #reopen(runId: string, revision: Revision): void {
    if (
      this.#options.documents.getLatest(runId, revision.documentKind)
        ?.status === "approved"
    )
      this.#options.gate.documentChanged(runId, revision.documentKind);
    if (this.#run(runId).status === "building")
      this.#options.runs.applyEvent(runId, { type: "issueOwnedByDesignAgent" });
    this.#memoryOf(runId).revisions.push(revision);
  }

  async #design(run: Run): Promise<void> {
    const memory = this.#memoryOf(run.id);
    let result;
    try {
      result = await this.#options.designPhase.run(run, memory.revisions);
    } catch (error) {
      if (!(error instanceof DesignPhaseError)) throw error;
      // With a person, the Run waits in designing, its revisions kept, and
      // advance tries again; with no one to ask, the Run fails.
      if (run.mode === "gated") throw error;
      this.#options.runs.applyEvent(run.id, { type: "designFailed" });
      this.#options.runs.recordFailure(run.id, {
        trigger: "design",
        summary: error.message,
        slice: null,
        reports: [],
      });
      return;
    }
    memory.revisions = [];
    if (result.screenImages.size > 0) memory.screenImages = result.screenImages;
    this.#checkpoint(run.id);
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
    const runner = await this.#options.sliceRunner(run, (checkpoint) =>
      this.#sliceCheckpoint(run.id, checkpoint),
    );
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
        this.#checkpoint(run.id);
        return;
      case "escalated":
        memory.histories.set(current.id, outcome.history);
        this.#checkpoint(run.id);
        this.#limit(run, outcome.trigger, outcome.summary, outcome.reports);
        return;
      case "designIssue":
        memory.histories.set(current.id, outcome.history);
        for (const { owner, reports } of outcome.revisions)
          this.#reopen(run.id, {
            agentRole: owner,
            documentKind: REVISED_DOCUMENT[owner],
            comments: reports
              .map(
                (report) =>
                  `${report.failingTest ?? `${report.step} step`}: ${report.error}`,
              )
              .join("\n"),
          });
        this.#checkpoint(run.id);
        return;
    }
  }

  /**
   * The Draft PR a Run that stopped early still owes, pushed once, whether it
   * stopped by a person's choice or by a limit in auto mode.
   */
  async #deliverIfOwed(run: Run): Promise<void> {
    const reason = this.#pendingDelivery.get(run.id);
    if (!reason) return;
    this.#pendingDelivery.delete(run.id);
    await this.#options.delivery.deliver(run.id, reason);
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
    if (current) this.#failTasks(run.id, current.id);
    // The failure report the Draft PR carries (diagram 3b).
    runs.recordFailure(run.id, {
      trigger,
      summary,
      slice: current?.title ?? null,
      reports: [...reports],
    });
    // With no one to ask, a failed Run always offers what it did finish.
    this.#pendingDelivery.set(run.id, { ended: "failed", openDraftPr: true });
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

  /** The Slice's unfinished Tasks end as failed: it was skipped or the Run ended. */
  #failTasks(runId: string, sliceId: string): void {
    for (const task of this.#options.tasks.listTasks(runId))
      if (task.sliceId === sliceId && task.status === "running")
        this.#options.tasks.setTaskStatus(task.id, "failed");
  }

  #run(runId: string): Run {
    const run = this.#options.runs.getRun(runId);
    if (!run) throw new NotFoundError("Run", runId);
    return run;
  }

  /**
   * What this Run carries. The first time a process asks for a Run it did not
   * build itself, the latest Checkpoint is read: that is how a resumed Run
   * knows what its Slices already failed on and what a person asked for.
   */
  #memoryOf(runId: string): RunMemory {
    let memory = this.#memory.get(runId);
    if (!memory) {
      const saved = memoryFromCheckpoint(
        this.#options.runs.latestCheckpoint(runId)?.payload,
      );
      memory = {
        revisions: saved?.revisions ?? [],
        histories: saved?.histories ?? new Map(),
        hints: saved?.hints ?? new Map(),
        screenImages: new Map(),
      };
      this.#memory.set(runId, memory);
    }
    return memory;
  }

  /**
   * A Checkpoint from inside a Slice (diagram 6). A Run killed between attempts
   * must come back knowing what it already failed on, so the retry it takes
   * next is the one it would have taken.
   */
  #sliceCheckpoint(runId: string, checkpoint: SliceCheckpoint): void {
    const memory = this.#memoryOf(runId);
    if (checkpoint.at === "retrying")
      memory.histories.set(checkpoint.sliceId, checkpoint.history);
    if (checkpoint.at === "committed")
      memory.histories.delete(checkpoint.sliceId);
    this.#checkpoint(runId);
  }

  #checkpoint(runId: string): void {
    this.#options.runs.saveCheckpoint(
      runId,
      checkpointPayload(this.#memoryOf(runId)),
    );
  }
}
