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
import type { Run, RunRuntime } from "@sdlc-code/core";
import type { Observable } from "rxjs";
import type { EventLog } from "./eventLog.js";
import {
  RunConflictError,
  RunNotFoundError,
  type RunDetail,
  type RunService,
  type RunSummary,
  type StartRunRequest,
  type StreamedEvent,
  type Waiting,
} from "./runService.js";

/** The parts of the runtime this service uses. */
export type ServiceRuntime = Pick<
  RunRuntime,
  | "runs"
  | "documents"
  | "slices"
  | "escalations"
  | "gates"
  | "orchestrator"
  | "startRun"
  | "resume"
>;

export type RuntimeRunServiceOptions = {
  /** Made on first use: a server with no keys still starts and says why. */
  runtime: () => ServiceRuntime;
  log: EventLog;
};

export class RuntimeRunService implements RunService {
  #runtime: () => ServiceRuntime;
  #log: EventLog;
  /** Runs being advanced now, by id, with the loop doing it. */
  #advancing = new Map<string, Promise<void>>();
  /** Runs whose state changed while their loop was running. */
  #again = new Set<string>();

  constructor(options: RuntimeRunServiceOptions) {
    this.#runtime = options.runtime;
    this.#log = options.log;
  }

  startRun = async (request: StartRunRequest): Promise<RunSummary> => {
    const run = await this.#runtime().startRun(request);
    this.#advance(run.id);
    return summary(run);
  };

  listRuns = (): RunSummary[] => this.#runtime().runs.listRuns().map(summary);

  getRun = (runId: string): RunDetail => this.#detail(this.#run(runId));

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

  events = (runId: string, after?: number): Observable<StreamedEvent> => {
    this.#run(runId);
    return this.#log.follow(runId, after);
  };

  /**
   * Picks up every Run the server was working on when it stopped (diagram 9):
   * what was in flight is discarded, and each continues in the background.
   */
  resumeUnfinished = async (): Promise<string[]> => {
    const runtime = this.#runtime();
    const resumed: string[] = [];
    for (const run of runtime.runs.listUnfinishedRuns()) {
      await runtime.resume(run.id);
      this.#advance(run.id);
      resumed.push(run.id);
    }
    return resumed;
  };

  /** Resolves once no Run is being advanced; for tests and for shutting down. */
  settled = async (): Promise<void> => {
    while (this.#advancing.size > 0)
      await Promise.allSettled([...this.#advancing.values()]);
  };

  /**
   * A person's decision, checked by the Orchestrator itself: a decision it
   * refuses (no open Gate, an empty hint) is a conflict the person can fix,
   * and nothing is advanced.
   */
  #decide(runId: string, decide: () => unknown): RunDetail {
    this.#run(runId);
    try {
      decide();
    } catch (error) {
      if (error instanceof Error) throw new RunConflictError(error.message);
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
          await this.#runtime().orchestrator.advance(runId);
        } while (this.#again.has(runId));
      } catch (error) {
        // A Run that throws has not failed by the domain's rules; it stopped,
        // and a restart resumes it. The person needs to know it stopped.
        this.#log.publish({
          runId,
          type: "problem",
          problem: `The Run stopped: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        this.#advancing.delete(runId);
      }
    })();
    this.#advancing.set(runId, loop);
  }

  #run(runId: string): Run {
    const run = this.#runtime().runs.getRun(runId);
    if (!run) throw new RunNotFoundError(runId);
    return run;
  }

  #detail(run: Run): RunDetail {
    const runtime = this.#runtime();
    return {
      ...summary(run),
      slices: runtime.slices.listSlices(run.id).map((slice) => ({
        title: slice.title,
        status: slice.status,
        isWalkingSkeleton: slice.isWalkingSkeleton,
        commitSha: slice.commitSha,
      })),
      documents: runtime.documents
        .listLatest(run.id)
        .map(({ kind, version, status }) => ({ kind, version, status })),
      waiting: this.#waiting(run),
      failure: run.failure
        ? {
            trigger: run.failure.trigger,
            summary: run.failure.summary,
            slice: run.failure.slice,
          }
        : null,
      advancing: this.#advancing.has(run.id),
    };
  }

  /** What a person is being asked, read from the Run's own state. */
  #waiting(run: Run): Waiting {
    const runtime = this.#runtime();
    switch (run.status) {
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
              trigger: escalation.trigger,
              summary: escalation.summary,
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
