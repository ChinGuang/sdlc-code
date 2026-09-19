/** Connects the agent loop to persistence: Transcript → Step events, Token Budget → Run. */
import type { RunStore } from "../persistence/runStore.js";
import { NotFoundError } from "../persistence/storeOptions.js";
import type { TaskStore } from "../persistence/taskStore.js";
import type { TokenBudget, Transcript, TranscriptEvent } from "./agentLoop.js";

/** Records a Step's Transcript as its event rows. */
export class StepTranscript implements Transcript {
  #tasks: TaskStore;
  #stepId: string;

  constructor(tasks: TaskStore, stepId: string) {
    this.#tasks = tasks;
    this.#stepId = stepId;
  }

  record = (event: TranscriptEvent): void => {
    const { type, ...payload } = event;
    this.#tasks.appendStepEvent(this.#stepId, type, payload);
  };
}

/** The Run's Token Budget, read from and charged to the stored Run. */
export class RunTokenBudget implements TokenBudget {
  #runs: RunStore;
  #runId: string;

  constructor(runs: RunStore, runId: string) {
    this.#runs = runs;
    this.#runId = runId;
  }

  remaining = (): number => {
    const run = this.#runs.getRun(this.#runId);
    if (!run) throw new NotFoundError("Run", this.#runId);
    return run.tokenBudget - run.tokensUsed;
  };

  spend = (tokens: number): void => {
    this.#runs.addTokensUsed(this.#runId, tokens);
  };
}
