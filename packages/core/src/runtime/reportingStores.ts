/**
 * Stores that say what changed as it changes (T21). A Run's status moves many
 * times inside one `advance` — designing, building, reviewing — and its Steps
 * start and end inside a Slice; reporting from the store that records each of
 * these means a client sees every one, in order, rather than a summary when
 * `advance` returns minutes later.
 *
 * Each wraps a store and changes nothing it does: it reports after the write
 * succeeded, so an event never describes something that did not happen.
 */
import type { RunStore } from "../persistence/runStore.js";
import type { TaskStore } from "../persistence/taskStore.js";
import type { RuntimeEvent } from "./runtimeEvents.js";

type Emit = (event: RuntimeEvent) => void;

/** A RunStore that reports every status a Run moves to, and what it spends. */
export function reportingRunStore(runs: RunStore, emit: Emit): RunStore {
  return {
    ...runs,
    applyEvent: (id, event) => {
      const run = runs.applyEvent(id, event);
      emit({ runId: id, type: "status", status: run.status });
      return run;
    },
    addTokensUsed: (id, tokens) => {
      const run = runs.addTokensUsed(id, tokens);
      emit({
        runId: id,
        type: "tokens",
        used: run.tokensUsed,
        budget: run.tokenBudget,
      });
      return run;
    },
  };
}

/**
 * One Run's TaskStore, reporting its Steps as they start and end. It is made
 * per Run, as the Slice runner that uses it is, because a Step names only its
 * Task and the Run is what a client follows.
 */
export function reportingTaskStore(
  tasks: TaskStore,
  runId: string,
  emit: Emit,
): TaskStore {
  const report = (
    stepId: string,
    taskId: string,
    phase: "started" | "completed" | "discarded",
  ) => {
    const task = tasks.listTasks(runId).find((one) => one.id === taskId);
    if (!task) return;
    emit({
      runId,
      type: "step",
      phase,
      stepId,
      taskId,
      role: task.agentRole,
      sliceId: task.sliceId,
    });
  };
  return {
    ...tasks,
    startStep: (taskId) => {
      const step = tasks.startStep(taskId);
      report(step.id, taskId, "started");
      return step;
    },
    completeStep: (stepId, workingMemory) => {
      const step = tasks.completeStep(stepId, workingMemory);
      report(step.id, step.taskId, "completed");
      return step;
    },
    discardStep: (stepId) => {
      const step = tasks.discardStep(stepId);
      report(step.id, step.taskId, "discarded");
      return step;
    },
  };
}
