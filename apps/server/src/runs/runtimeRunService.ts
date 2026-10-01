/**
 * RunService over the core runtime (T21). A request never waits for a Run to
 * make progress: a decision is recorded, the answer goes back at once, and the
 * Run is advanced in the background until it needs a person again or finishes.
 * What it does meanwhile arrives on the event stream.
 *
 * One Run is advanced by one loop at a time. A decision that arrives while its
 * Run is already advancing only records the decision; the running loop picks it
 * up, because `advance` reads the Run's state from the stores each time round.
 */
import {
  documentsMadeStale,
  IllegalTransitionError,
  isAgentRole,
  memoryFromCheckpoint,
  MissingKeyError,
  type RunMemoryState,
  type AgentRole,
  type DocumentKind,
  type DocumentStatus,
  type Run,
  type RunRuntime,
  type Task,
} from "@sdlc-code/core";
import type { Observable } from "rxjs";
import type { EventLog } from "./eventLog.js";
import {
  DocumentNotFoundError,
  RunConflictError,
  RunNotFoundError,
  RuntimeUnavailableError,
  type DocumentView,
  type IssueSummary,
  type RunDetail,
  type RunLifecycle,
  type RunService,
  type RunSummary,
  type StartRunRequest,
  type StreamedEvent,
  type Waiting,
  type WorkingMemoryNote,
} from "./runService.js";

/** The parts of the runtime this service uses. */
export type ServiceRuntime = Pick<
  RunRuntime,
  | "runs"
  | "documents"
  | "slices"
  | "tasks"
  | "escalations"
  | "reviews"
  | "orchestrator"
  | "startRun"
  | "resume"
  | "redact"
  | "close"
>;

export type RuntimeRunServiceOptions = {
  /**
   * The runtime, made on first use: a server without its keys still starts,
   * answers /health, and says what is missing. Throws RuntimeUnavailableError
   * until it can be made.
   */
  runtime: () => ServiceRuntime;
  /** Whether the runtime was ever made, so shutting down does not make one. */
  made: () => boolean;
  log: EventLog;
};

export class RuntimeRunService implements RunService, RunLifecycle {
  #runtime: () => ServiceRuntime;
  #made: () => boolean;
  #log: EventLog;
  /** Runs being advanced now, by id, with the loop doing it. */
  #advancing = new Map<string, Promise<void>>();
  /** Runs whose state changed while their loop was running. */
  #again = new Set<string>();

  constructor(options: RuntimeRunServiceOptions) {
    this.#runtime = options.runtime;
    this.#made = options.made;
    this.#log = options.log;
  }

  startRun = async (request: StartRunRequest): Promise<RunSummary> => {
    let run: Run;
    try {
      run = await this.#runtime().startRun(request);
    } catch (error) {
      // A Target Repo without GITHUB_TOKEN: the server cannot do this one yet.
      if (error instanceof MissingKeyError)
        throw new RuntimeUnavailableError(error.message);
      throw error;
    }
    this.#advance(run.id);
    return summary(run);
  };

  listRuns = (): RunSummary[] => this.#runtime().runs.listRuns().map(summary);

  getRun = (runId: string): RunDetail => this.#detail(this.#run(runId));

  getDocument = (runId: string, kind: DocumentKind): DocumentView => {
    const run = this.#run(runId);
    const document = this.#runtime().documents.getLatest(run.id, kind);
    if (!document) throw new DocumentNotFoundError(run.id, kind);
    return {
      kind: document.kind,
      version: document.version,
      status: document.status,
      ownerAgent: document.ownerAgent,
      content: document.content,
    };
  };

  retryDesign: RunService["retryDesign"] = (runId) =>
    this.#decide(runId, () => this.#runtime().orchestrator.retryDesign(runId));

  decideDesign: RunService["decideDesign"] = (runId, verdicts) =>
    this.#decide(runId, () =>
      this.#runtime().orchestrator.decideDesign(runId, verdicts),
    );

  resolveEscalation: RunService["resolveEscalation"] = (runId, resolution) =>
    this.#decide(runId, () =>
      this.#runtime().orchestrator.resolveEscalation(runId, resolution),
    );

  decidePullRequest: RunService["decidePullRequest"] = (runId, decision) =>
    this.#decide(runId, () =>
      this.#runtime().orchestrator.decidePullRequest(runId, decision),
    );

  abortRun = (runId: string, openDraftPrOnAbort: boolean): RunDetail => {
    if (this.#waiting(this.#run(runId)).for !== "escalation")
      throw new RunConflictError(
        `Run ${runId} is not at an Escalation, and a Run is aborted from one.`,
      );
    return this.resolveEscalation(runId, {
      choice: "abort",
      openDraftPrOnAbort,
    });
  };

  events = (runId: string, after?: number): Observable<StreamedEvent> => {
    this.#run(runId);
    return this.#log.follow(runId, after);
  };

  resumeUnfinished: RunLifecycle["resumeUnfinished"] = async () => {
    const runtime = this.#runtime();
    const resumed: string[] = [];
    const failed: Array<{ runId: string; problem: string }> = [];
    for (const run of runtime.runs.listUnfinishedRuns()) {
      try {
        await runtime.resume(run.id);
        this.#advance(run.id);
        resumed.push(run.id);
      } catch (error) {
        failed.push({ runId: run.id, problem: this.#describe(error) });
      }
    }
    return { resumed, failed };
  };

  /**
   * Closes what the runtime opened. It does not wait for Runs being advanced:
   * a Step can take minutes, and the next start resumes it anyway.
   */
  shutdown = async (): Promise<void> => {
    if (this.#made()) await this.#runtime().close();
  };

  /** Resolves once no Run is being advanced. For tests. */
  settled = async (): Promise<void> => {
    while (this.#advancing.size > 0)
      await Promise.allSettled([...this.#advancing.values()]);
  };

  /**
   * A person's decision, checked by the Orchestrator: a decision it refuses (no
   * open Gate, an empty hint, a move the lifecycle does not allow) is a conflict
   * the person can fix, and nothing is advanced. Anything else is a fault, and
   * goes on as one.
   */
  #decide(runId: string, decide: () => unknown): RunDetail {
    this.#run(runId);
    try {
      decide();
    } catch (error) {
      if (isRefusal(error)) throw new RunConflictError(error.message);
      throw error;
    }
    this.#advance(runId);
    return this.#detail(this.#run(runId));
  }

  /** Advances the Run in the background until it waits for a person. */
  #advance(runId: string): void {
    if (this.#advancing.has(runId)) {
      this.#again.add(runId);
      return;
    }
    const loop = (async () => {
      try {
        do {
          this.#again.delete(runId);
          const progress = await this.#runtime().orchestrator.advance(runId);
          // The status stays designing, so say it: a follower would wait on.
          if ("waitingFor" in progress && progress.waitingFor === "designRetry")
            this.#log.publish({
              runId,
              type: "problem",
              problem: `The design failed: ${this.#describe(progress.problem)}`,
            });
        } while (this.#again.has(runId));
      } catch (error) {
        // A Run that throws has not failed by the domain's rules; it stopped,
        // and a restart resumes it. Its followers need to know it stopped.
        this.#log.publish({
          runId,
          type: "problem",
          problem: `The Run stopped: ${this.#describe(error)}`,
        });
      } finally {
        this.#advancing.delete(runId);
      }
    })();
    this.#advancing.set(runId, loop);
  }

  /** An error as a person may read it, with the runtime's keys taken out. */
  #describe(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return this.#made() ? this.#runtime().redact(text) : text;
  }

  #run(runId: string): Run {
    const run = this.#runtime().runs.getRun(runId);
    if (!run) throw new RunNotFoundError(runId);
    return run;
  }

  #detail(run: Run): RunDetail {
    const runtime = this.#runtime();
    const memory = memoryFromCheckpoint(
      runtime.runs.latestCheckpoint(run.id)?.payload,
    );
    return {
      ...summary(run),
      slices: runtime.slices.listSlices(run.id).map((slice) => ({
        id: slice.id,
        title: slice.title,
        status: slice.status,
        isWalkingSkeleton: slice.isWalkingSkeleton,
        commitSha: slice.commitSha,
      })),
      documents: documentsWithCascade(runtime.documents.listLatest(run.id)),
      reviews: runtime.reviews.listReviews(run.id).map((review) => ({
        findings: review.findings.map((finding) => ({
          ruleId: finding.ruleId,
          severity: finding.severity,
          source: finding.source,
          file: finding.file,
          line: finding.line,
          message: finding.message,
          suggestion: finding.suggestion ?? null,
        })),
        stopReason: review.stopReason,
        problems: review.problems,
        createdAt: review.createdAt,
      })),
      tasks: runtime.tasks.listTasks(run.id).map((task) => ({
        id: task.id,
        sliceId: task.sliceId,
        role: task.agentRole,
        status: task.status,
        retriesSpent: retriesSpent(task, memory),
        // Not the Transcript: when a Step ran and how it ended is enough to
        // draw a lane, and the rest is Working Memory's to summarise.
        steps: runtime.tasks.listSteps(task.id).map((step) => ({
          id: step.id,
          status: step.status,
          startedAt: step.startedAt,
          endedAt: step.endedAt,
        })),
      })),
      waiting: this.#waiting(run),
      failure: run.failure
        ? {
            trigger: run.failure.trigger,
            summary: run.failure.summary,
            slice: run.failure.slice,
          }
        : null,
      advancing: this.#advancing.has(run.id),
      lastSeq: this.#log.lastSeq(run.id),
    };
  }

  /**
   * What each agent working on the stopped Slice last wrote: what it tried,
   * which is what a person needs to give a useful hint.
   */
  #workingMemory(
    runId: string,
    sliceTitle: string | null,
  ): WorkingMemoryNote[] {
    const runtime = this.#runtime();
    const slice = runtime.slices
      .listSlices(runId)
      .find((one) => one.title === sliceTitle);
    if (!slice) return [];
    return runtime.tasks
      .listTasks(runId)
      .filter((task) => task.sliceId === slice.id)
      .flatMap((task) => {
        const note = runtime.tasks
          .listSteps(task.id)
          .findLast((step) => step.workingMemory !== null)?.workingMemory;
        return note ? [{ role: task.agentRole, note }] : [];
      });
  }

  /** What a person is being asked, read from the Run's own state. */
  #waiting(run: Run): Waiting {
    const runtime = this.#runtime();
    switch (run.status) {
      case "designing":
        return run.mode === "gated" && run.failure?.trigger === "design"
          ? { for: "designRetry", problem: run.failure.summary }
          : { for: "nothing" };
      case "awaitingDesignGate":
        return {
          for: "designGate",
          documents: runtime.documents
            .listLatest(run.id)
            .filter((document) => document.status === "inReview")
            .map(({ kind, version }) => ({ kind, version })),
        };
      case "escalated": {
        const escalation = runtime.escalations.getOpenEscalation(run.id);
        return escalation
          ? {
              for: "escalation",
              id: escalation.id,
              trigger: escalation.trigger,
              summary: escalation.summary,
              slice: escalation.slice,
              reports: escalation.reports.map(issueSummary),
              workingMemory: this.#workingMemory(run.id, escalation.slice),
              openDraftPrOnAbort: escalation.openDraftPrOnAbort,
            }
          : { for: "nothing" };
      }
      case "awaitingPrGate":
        return { for: "prGate", pullRequest: run.pullRequest };
      default:
        return { for: "nothing" };
    }
  }
}

/**
 * The Orchestrator refuses a decision with a plain Error or an illegal move;
 * a database or network fault is some other kind, and is not the person's to
 * fix.
 */
function isRefusal(error: unknown): error is Error {
  return (
    error instanceof IllegalTransitionError ||
    (error instanceof Error && error.constructor === Error)
  );
}

function summary(run: Run): RunSummary {
  return {
    id: run.id,
    projectRequest: run.projectRequest,
    mode: run.mode,
    status: run.status,
    tokensUsed: run.tokensUsed,
    tokenBudget: run.tokenBudget,
    pullRequest: run.pullRequest,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

const SIDE = { backendCoding: "backend", frontendCoding: "frontend" } as const;

/**
 * A Task's retries as its Retry Budget counts them: from the baseline the Run
 * last saved for its Slice, which a hint (a person's, or a Code Review's) moves
 * up to the retries already spent, refilling the budget. With no baseline the
 * Slice is on its first budget, which starts at none spent.
 */
export function retriesSpent(
  task: Pick<Task, "sliceId" | "agentRole" | "retries">,
  memory: RunMemoryState | null,
): number {
  if (task.sliceId === null) return task.retries;
  const side =
    task.agentRole === "backendCoding" || task.agentRole === "frontendCoding"
      ? SIDE[task.agentRole]
      : null;
  if (side === null) return task.retries;
  // A hint not yet taken up: its Slice starts a fresh budget when it is.
  if (memory?.hints.has(task.sliceId)) return 0;
  const baseline =
    memory?.histories.get(task.sliceId)?.retryBaseline[side] ?? 0;
  return Math.max(0, task.retries - baseline);
}

/**
 * Each document with what a change to it would make Stale, given where the
 * others are now: the Design Gate warns before a person asks for it.
 */
function documentsWithCascade(
  documents: ReadonlyArray<{
    kind: DocumentKind;
    version: number;
    status: DocumentStatus;
    ownerAgent: AgentRole;
  }>,
): RunDetail["documents"] {
  const statuses = Object.fromEntries(
    documents.map(({ kind, status }) => [kind, status]),
  );
  return documents.map(({ kind, version, status, ownerAgent }) => ({
    kind,
    version,
    status,
    ownerAgent,
    wouldMakeStale: documentsMadeStale(kind, statuses),
  }));
}

/**
 * An Issue Report as stored, cut to what a person reads. Stored as JSON, so
 * each field is checked rather than trusted: a report from an older version
 * shows what it has.
 */
export function issueSummary(stored: unknown): IssueSummary {
  const report = (stored ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    step: text(report.step) ?? "unknown",
    failingTest: text(report.failingTest),
    file: text(report.file),
    endpoint: text(report.endpoint),
    error: text(report.error) ?? "(no error recorded)",
    suspectedOwner: isAgentRole(text(report.suspectedOwner) ?? "")
      ? (report.suspectedOwner as AgentRole)
      : null,
    occurrences:
      typeof report.occurrences === "number" ? report.occurrences : 1,
  };
}
