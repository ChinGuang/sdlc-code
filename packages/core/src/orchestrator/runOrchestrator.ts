// SPDX-License-Identifier: MPL-2.0
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
import { RunStoppedError } from "../agentLoop/agentLoop.js";
import {
  isFinished,
  type EscalationTrigger,
  type RunStatus,
} from "../domain/runLifecycle.js";
import type { EscalationStore } from "../persistence/escalationStore.js";
import type { ReviewStore } from "../persistence/reviewStore.js";
import type { ScreenshotStore } from "../persistence/screenshotStore.js";
import type { RunStore } from "../persistence/runStore.js";
import { NotFoundError } from "../persistence/storeOptions.js";
import type { DocumentStore } from "../persistence/documentStore.js";
import type { SliceStore } from "../persistence/sliceStore.js";
import type { TaskStore } from "../persistence/taskStore.js";
import {
  loadApprovedDocuments,
  MissingDocumentError,
} from "./approvedDocuments.js";
import type { EscalationBriefer } from "./escalationBrief.js";
import { lastWorkingMemory } from "./workingMemory.js";
import type { ApprovedDocuments } from "../agents/coding/codingContext.js";
import type {
  DesignGate,
  DesignVerdict,
  GateDecision,
  Revision,
} from "./designGate.js";
import { DesignPhaseError, type DesignPhase } from "./designPhase.js";
import {
  checkpointPayload,
  IssueReportSchema,
  memoryFromCheckpoint,
  type RunMemoryState,
} from "./runCheckpoint.js";
import type { SliceCheckpoint, SliceHint, SliceRunner } from "./sliceRunner.js";
import type { RunDelivery } from "../delivery/runDelivery.js";
import {
  asCodingIssue,
  asPullRequestFinding,
  blockingFindings,
  nonBlockingFindings,
  type Finding,
} from "../agents/codeReview/findings.js";
import type { RunReview } from "./runReview.js";
import type { GateStore } from "../persistence/gateStore.js";

/** Where a Run stopped, and why. */
export type RunProgress =
  | { waitingFor: "designGate" }
  /** No valid design came out of a gated Run: a person asks for another try. */
  | { waitingFor: "designRetry"; problem: string }
  | { waitingFor: "escalation"; escalation: Escalation }
  | { waitingFor: "prGate"; pullRequest: RunPullRequest | null }
  | { finished: Extract<RunStatus, "done" | "failed" | "aborted"> };

/** The human's decision at the PR Gate (diagram 8). */
export type PullRequestDecision =
  { choice: "approve" } | { choice: "requestChanges"; comments: string };

/**
 * Every way on but abort spends tokens, so a Run whose Token Budget is spent
 * goes on only with a higher one.
 */
type GoingOn = { tokenBudget?: number };

/** Who a retry's hint is for (T24i): one Coding Agent, or both. */
export const HINT_SIDES = [
  "backend",
  "frontend",
  "both",
] as const satisfies readonly (CodingSide | "both")[];
export type HintSide = (typeof HINT_SIDES)[number];

export type EscalationResolution =
  | ({
      choice: "retryWithHint";
      hint: string;
      /**
       * Who the hint is for (T24i). Without one, the side the Issue Reports
       * point at, or both when they point at neither.
       */
      side?: HintSide;
    } & GoingOn)
  | ({
      choice: "editDocuments";
      /** What to change in each document; its owning agent revises it. */
      edits: Array<{ documentKind: DocumentKind; comments: string }>;
    } & GoingOn)
  | ({ choice: "skipSlice" } & GoingOn)
  | { choice: "abort"; openDraftPrOnAbort?: boolean };

export interface RunOrchestrator {
  /** Runs until a person must decide or the Run leaves building. */
  advance: (runId: string) => Promise<RunProgress>;
  /** Clears a gated Run's failed design so advance designs again. */
  retryDesign: (runId: string) => void;
  /**
   * A person stops the Run, whatever it is doing (T24g): at an Escalation as
   * its abort choice, otherwise at once. Work under way stops at the next
   * model turn; call advance to settle it and deliver what is owed. An
   * aborted Run whose pull request never opened is aborted again to try its
   * delivery again, with the new choice; one that has a pull request, or has
   * finished, is refused.
   */
  abort: (runId: string, options?: { openDraftPrOnAbort?: boolean }) => void;
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
  /**
   * The review that runs before the pull request (T19). Without it a Run's code
   * is delivered unreviewed, which is what happened before T19 existed.
   */
  codeReview?: RunReview;
  /** Where each review is kept for the PR Gate; none is kept without it. */
  reviews?: ReviewStore;
  /** The screens as drawn; a resumed Run gives them to its Coding Agents again. */
  screenshots?: ScreenshotStore;
  /** Told when a review could not be trusted, e.g. an invented Rule ID. */
  onReviewProblem?: (runId: string, problem: string) => void;
  /**
   * Writes each new Escalation's brief (T24c), spending that Run's Token
   * Budget. Without it an Escalation has none, as before T24c.
   */
  briefer?: (run: Run) => EscalationBriefer;
  /** Told when a brief could not be written; the Escalation stands without one. */
  onBriefProblem?: (runId: string, problem: string) => void;
  /** How often blocking Findings may send the code back. Defaults to 3. */
  reviewRetryBudget?: number;
  /**
   * The Design Phase for a Run: its agents spend that Run's Token Budget, as
   * the Slice runner's do.
   */
  designPhase: (run: Run) => DesignPhase;
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

/** The Retry Budget of CONTEXT.md, applied to the review as to a Slice. */
const DEFAULT_REVIEW_RETRIES = 3;

const REVISED_DOCUMENT: Record<"systemDesign" | "uiDesign", DocumentKind> = {
  // The API Contract lacks what the Slice Plan or a test needs.
  systemDesign: "apiContract",
  uiDesign: "uiSpec",
};

export class AgentRunOrchestrator implements RunOrchestrator {
  #options: RunOrchestratorOptions;
  #memory = new Map<string, RunMemory>();
  /**
   * Escalations this process opened and has not briefed yet. Kept in memory
   * on purpose: a restart never spends tokens on an Escalation no one is
   * looking at for the first time.
   */
  #briefsOwed = new Set<string>();

  constructor(options: RunOrchestratorOptions) {
    this.#options = options;
  }

  advance = async (runId: string): Promise<RunProgress> => {
    for (;;) {
      // What a Run already aborted throws (a failed Draft PR push) is a
      // fault like any other; only work the abort cut short is swallowed.
      const abortedBefore = this.#run(runId).status === "aborted";
      try {
        const progress = await this.#next(runId);
        if (progress) return progress;
      } catch (error) {
        if (abortedBefore || this.#run(runId).status !== "aborted") throw error;
        this.#settleStopped(runId);
      }
    }
  };

  abort = (
    runId: string,
    { openDraftPrOnAbort = true }: { openDraftPrOnAbort?: boolean } = {},
  ): void => {
    const run = this.#run(runId);
    if (run.status === "escalated") {
      this.resolveEscalation(runId, { choice: "abort", openDraftPrOnAbort });
      return;
    }
    // An aborted Run whose Draft PR never opened (GitHub refused it, the
    // repository was empty: found in T25) is aborted again to try again, with
    // the person's choice this time. Nothing else is left to stop.
    if (run.status === "aborted" && !run.pullRequest) {
      this.#options.runs.setOpenDraftPrOnAbort(runId, openDraftPrOnAbort);
      return;
    }
    if (isFinished(run.status))
      throw new Error(`Run ${runId} is ${run.status} already.`);
    this.#options.runs.setOpenDraftPrOnAbort(runId, openDraftPrOnAbort);
    this.#options.runs.applyEvent(runId, { type: "aborted" });
  };

  /**
   * One move of the Run, or what it waits for: null when it moved and should
   * be looked at again.
   */
  async #next(runId: string): Promise<RunProgress | null> {
    const run = this.#run(runId);
    switch (run.status) {
      case "designing":
        // Tried again only when a person asks: not by itself, and not on
        // a restart, which would spend tokens no one asked it to.
        if (run.mode === "gated" && run.failure?.trigger === "design")
          return { waitingFor: "designRetry", problem: run.failure.summary };
        await this.#design(run);
        return null;
      case "building":
        await this.#build(run);
        return null;
      case "awaitingDesignGate":
        return { waitingFor: "designGate" };
      case "escalated": {
        const escalation = this.#options.escalations.getOpenEscalation(runId);
        if (!escalation)
          throw new Error(
            `Run ${runId} is escalated but has no open Escalation.`,
          );
        if (this.#briefsOwed.delete(escalation.id)) {
          await this.#writeBrief(run, escalation);
          // A person may have decided while it was written: look again.
          return null;
        }
        return { waitingFor: "escalation", escalation };
      }
      case "reviewing":
        await this.#review(run);
        return null;
      case "awaitingPrGate": {
        // A process that died between opening the pull request and opening
        // the Gate would otherwise leave nothing for a person to answer.
        if (!this.#options.gates.getOpenGate(run.id))
          this.#options.gates.openGate(run.id, "pr");
        return { waitingFor: "prGate", pullRequest: run.pullRequest };
      }
      case "done":
      case "failed":
      case "aborted":
        // An abort while nothing advanced it (a Gate, a Run whose loop
        // stopped) leaves its Tasks as they were; settling twice is harmless.
        if (run.status === "aborted") this.#settleStopped(runId);
        await this.#deliverIfOwed(run);
        return { finished: run.status };
    }
  }

  retryDesign = (runId: string): void => {
    const run = this.#run(runId);
    if (run.status !== "designing" || run.failure?.trigger !== "design")
      throw new Error(`Run ${runId} has no failed design to try again.`);
    this.#options.runs.clearFailure(runId);
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
    const raised =
      resolution.choice === "abort" ? undefined : resolution.tokenBudget;
    const run = runs.getRun(runId)!;
    if (raised !== undefined && raised <= run.tokensUsed)
      throw new Error(
        `A Token Budget of ${raised} is not more than the ${run.tokensUsed} tokens already spent.`,
      );
    // Going on with nothing left to spend would stop again at once, at the
    // same Escalation.
    if (
      resolution.choice !== "abort" &&
      (raised ?? run.tokenBudget) <= run.tokensUsed
    )
      throw new Error(
        "The Token Budget is spent: raise it to go on, or abort the Run.",
      );
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
    if (raised !== undefined) runs.setTokenBudget(runId, raised);
    runs.applyEvent(runId, {
      type: "escalationResolved",
      choice: resolution.choice,
    });
    const memory = this.#memoryOf(runId);
    switch (resolution.choice) {
      case "retryWithHint":
        if (current)
          memory.hints.set(current.id, {
            from: "person",
            issues: [{ summary: resolution.hint, evidence: resolution.hint }],
            ...hintedSides(resolution.side ?? sideAtFault(escalation.reports)),
          });
        // A person chose to try again, so the review gets its attempts back too.
        memory.reviewRetries = 0;
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
        // Diagram 3b: the passed Slices still reach the Target Repo unless the
        // person unticked the checkbox, which the Escalation records. advance
        // does the pushing, so answering a person never waits for GitHub.
        break;
    }
    // The person's decision is the thing a resumed Run must not lose.
    this.#checkpoint(runId);
  };

  decidePullRequest = (runId: string, decision: PullRequestDecision): void => {
    const { runs, gates } = this.#options;
    if (decision.choice === "requestChanges" && !decision.comments.trim())
      throw new Error("Say what to change, or approve the pull request.");
    const gate = gates.getOpenGate(runId);
    // An aborted Run may keep its Gate row open: the status is what counts.
    if (
      !gate ||
      gate.kind !== "pr" ||
      this.#run(runId).status !== "awaitingPrGate"
    )
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
    if (decision.choice === "approve") {
      this.#checkpoint(runId);
      return;
    }
    // Diagram 8: the changes are a fix Task, so the last Slice is built again.
    this.#reopenLastSlice(runId, {
      from: "person",
      issues: [{ summary: decision.comments, evidence: decision.comments }],
    });
  };

  /**
   * The Slices are built and tested, so the code is reviewed before anyone is
   * asked to look at it (diagram 8): the linters run in the sandbox, then the
   * Code Review Agent reads the diff against the Review Standard and the
   * Approved Documents. Blocking Findings send the work back; the rest travel
   * to the pull request's description.
   */
  async #review(run: Run): Promise<void> {
    const { runs, gates, delivery, codeReview } = this.#options;
    const reviewed = codeReview ? await codeReview.reviewRun(run) : null;
    if (reviewed)
      this.#options.reviews?.saveReview(run.id, {
        findings: reviewed.findings,
        stopReason: reviewed.stopReason,
        problems: reviewed.problems,
      });
    for (const problem of reviewed?.problems ?? [])
      this.#options.onReviewProblem?.(run.id, problem);
    const blocking = blockingFindings(reviewed?.findings ?? []);
    if (blocking.length > 0) {
      this.#sendBack(run, blocking);
      return;
    }
    // A review that ran out of turns or Token Budget read part of the diff, so
    // it has not said the code is good; opening a pull request on its silence
    // would be the one thing this step exists to prevent.
    if (reviewed && reviewed.stopReason !== "answered") {
      this.#limit(
        run,
        reviewed.stopReason === "tokenBudget" ? "tokenBudget" : "retryBudget",
        `The review did not finish (${reviewed.stopReason}), so the code is not reviewed.`,
        [],
      );
      return;
    }
    // The review's last turn may finish after a person aborted: nothing that
    // would open a ready pull request happens then.
    if (this.#run(run.id).status === "aborted") throw new RunStoppedError();
    const outcome = await delivery.deliver(run.id, {
      ended: "complete",
      findings: nonBlockingFindings(reviewed?.findings ?? []).map(
        asPullRequestFinding,
      ),
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
   * Blocking Findings are a fix Task (diagram 8): the last Slice is built again
   * with them, as the PR Gate's changes are. The Run leaves reviewing, so the
   * review runs again once the Slice passes.
   */
  #sendBack(run: Run, blocking: readonly Finding[]): void {
    const { runs } = this.#options;
    const memory = this.#memoryOf(run.id);
    const budget = this.#options.reviewRetryBudget ?? DEFAULT_REVIEW_RETRIES;
    // A review that keeps refusing the same code must stop asking, or a Run
    // rebuilds its last Slice for ever (diagram 3: reviewing → escalated).
    if (memory.reviewRetries >= budget) {
      this.#limit(
        run,
        "retryBudget",
        `The review still refuses the code after ${budget} attempts: ${blocking
          .map((finding) => asCodingIssue(finding).summary)
          .join("; ")}`,
        [],
      );
      return;
    }
    memory.reviewRetries++;
    runs.applyEvent(run.id, { type: "blockingFindings" });
    this.#reopenLastSlice(run.id, {
      from: "codeReview",
      issues: blocking.map(asCodingIssue),
    });
  }

  /**
   * Building the last Slice again with something to fix, which is what both a
   * blocking Finding and the PR Gate's requested changes come down to. Its
   * Slice Commit stays on the run branch until the new attempt earns one.
   */
  #reopenLastSlice(runId: string, hint: SliceHint): void {
    const last = this.#options.slices
      .listSlices(runId)
      .filter((slice) => slice.status === "passed")
      .at(-1);
    if (last) {
      this.#options.slices.moveSlice(last.id, "building");
      this.#memoryOf(runId).hints.set(last.id, hint);
    }
    this.#checkpoint(runId);
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
      result = await this.#options.designPhase(run).run(run, memory.revisions);
    } catch (error) {
      if (!(error instanceof DesignPhaseError)) throw error;
      // With a person, the Run waits in designing, its revisions kept, and
      // says why (retryDesign tries again); with no one to ask, it fails.
      if (run.mode === "gated") {
        this.#options.runs.recordFailure(run.id, {
          trigger: "design",
          summary: error.message,
          slice: null,
          reports: [],
        });
        return;
      }
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
    // A redraw replaces the images, even with none: the old ones show screens
    // that no longer exist.
    if (result.redrawn) memory.screenImages = result.screenImages;
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
    // Kept until the Slice's first retry or its end, so a restart before
    // then gives the attempt the same hint for the same sides (T24i).
    const hint = memory.hints.get(current.id);
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
    memory.hints.delete(current.id);
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
   * The Draft PR a Run that stopped early still owes (diagram 3b). Read from
   * the Run and its Escalation rather than remembered, so a Run that stopped
   * and then lost its process still offers what it finished; the pull request
   * it records is what stops it being offered twice.
   */
  async #deliverIfOwed(run: Run): Promise<void> {
    // Only a Run that stopped early owes one: a Run that is done opened its
    // pull request in #review, and every other status is still going.
    if (run.status !== "failed" && run.status !== "aborted") return;
    if (run.pullRequest) return;
    await this.#options.delivery.deliver(run.id, {
      ended: run.status,
      // A failure in auto mode has nobody to ask, so it always offers one.
      openDraftPr:
        run.status === "failed" ? true : this.#abortedWithDraftPr(run.id),
    });
  }

  /**
   * A Run a person stopped mid-work: the Step that was running is discarded
   * (a Step is redone, never resumed, and this one never will be) and the
   * Slice's Tasks fail. The Run is aborted already.
   */
  #settleStopped(runId: string): void {
    const { tasks } = this.#options;
    for (const task of tasks.listTasks(runId))
      for (const step of tasks.listSteps(task.id))
        if (step.status === "running") tasks.discardStep(step.id);
    const current = this.#currentSlice(runId);
    if (current) this.#failTasks(runId, current.id);
  }

  /** What the person ticked when they aborted; the default is to offer one. */
  #abortedWithDraftPr(runId: string): boolean {
    const asked = this.#run(runId).openDraftPrOnAbort;
    if (asked !== null) return asked;
    const abort = this.#options.escalations
      .listEscalations(runId)
      .filter((escalation) => escalation.choice === "abort")
      .at(-1);
    return abort?.openDraftPrOnAbort ?? true;
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
    const current = this.#currentSlice(run.id);
    if (next.status === "escalated") {
      const escalation = escalations.openEscalation(run.id, {
        trigger,
        summary,
        slice: current?.title ?? null,
        reports: [...reports],
      });
      if (this.#options.briefer) this.#briefsOwed.add(escalation.id);
      return;
    }
    if (current) this.#failTasks(run.id, current.id);
    // The failure report the Draft PR carries (diagram 3b).
    runs.recordFailure(run.id, {
      trigger,
      summary,
      slice: current?.title ?? null,
      reports: [...reports],
    });
  }

  /**
   * The Escalation's brief (T24c). A brief helps the person; it is never
   * worth stopping the Run for, so whatever goes wrong is reported and the
   * Escalation stands without one.
   */
  async #writeBrief(run: Run, escalation: Escalation): Promise<void> {
    const { slices, tasks, escalations } = this.#options;
    const slice =
      slices.listSlices(run.id).find((one) => one.title === escalation.slice) ??
      null;
    try {
      const brief = await this.#options.briefer!(run).brief({
        run,
        escalation,
        sliceId: slice?.id ?? null,
        // Stored as JSON: a row this version cannot read is left out.
        reports: escalation.reports.flatMap((stored) => {
          const report = IssueReportSchema.safeParse(stored);
          return report.success ? [report.data] : [];
        }),
        workingMemory: lastWorkingMemory(
          { slices, tasks },
          run.id,
          escalation.slice,
        ),
        documents: this.#approvedDocumentsOrNull(run.id),
      });
      escalations.setBrief(escalation.id, brief);
    } catch (error) {
      if (error instanceof RunStoppedError) throw error;
      this.#options.onBriefProblem?.(
        run.id,
        `The Escalation's brief could not be written: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** None before the design is approved: an Escalation can come before it. */
  #approvedDocumentsOrNull(runId: string): ApprovedDocuments | null {
    try {
      return loadApprovedDocuments(this.#options.documents, runId);
    } catch (error) {
      if (error instanceof MissingDocumentError) return null;
      throw error;
    }
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
        reviewRetries: saved?.reviewRetries ?? 0,
        // Not in the Checkpoint (bytes, not decisions), but kept beside it.
        screenImages: this.#options.screenshots?.images(runId) ?? new Map(),
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
    if (checkpoint.at === "retrying") {
      memory.histories.set(checkpoint.sliceId, checkpoint.history);
      // The hint was for the first attempt; its history now says who codes.
      memory.hints.delete(checkpoint.sliceId);
    }
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

/**
 * The side Issue Reports point at (T24i): the one Coding Agent every report
 * suspects, or "both" when they suspect both, or any report suspects no one.
 * Stored reports are JSON, so each is read rather than trusted.
 */
export function sideAtFault(reports: readonly unknown[]): HintSide {
  const owners = new Set(
    reports.map((report) => {
      const owner = (report as { suspectedOwner?: unknown } | null)
        ?.suspectedOwner;
      return owner === "backendCoding"
        ? "backend"
        : owner === "frontendCoding"
          ? "frontend"
          : null;
    }),
  );
  const [only] = owners;
  return owners.size === 1 && only ? only : "both";
}

/** A hint for both sides names none: every side of the Slice codes. */
function hintedSides(side: HintSide): Pick<SliceHint, "sides"> {
  return side === "both" ? {} : { sides: [side] };
}
