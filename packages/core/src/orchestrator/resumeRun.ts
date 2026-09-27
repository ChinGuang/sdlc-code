/**
 * Picking a Run back up (UML diagram 9). A Run stops for ordinary reasons — a
 * spent Token Budget, a closed laptop, a killed process — and everything it
 * finished is already on disk: Slice Commits on the run branch, Steps and their
 * Working Memory in the database, its decisions in a Checkpoint.
 *
 * What is not trustworthy is whatever was in flight. So resuming throws that
 * away rather than guessing at it: the running Steps are discarded, the
 * unfinished worktrees are deleted, and the Run's next action is the one it
 * would have taken before the interrupted Step began.
 */
import type { Run } from "../domain/entities.js";
import type { RunStore } from "../persistence/runStore.js";
import type { TaskStore } from "../persistence/taskStore.js";
import type { WorkspaceManager } from "../workspaces/workspaceManager.js";

export type ResumeRunOptions = {
  runs: RunStore;
  tasks: TaskStore;
  /** The Run's Workspaces; its unfinished worktrees are discarded. */
  workspaces: WorkspaceManager;
};

export type ResumedRun = {
  run: Run;
  /** Steps that were running when the Run stopped, and are now discarded. */
  discardedSteps: number;
  /** Whether the Run had a Checkpoint this version understands. */
  hadCheckpoint: boolean;
};

/**
 * Makes one unfinished Run safe to continue, then hands it back; the caller
 * carries on with `advance`. Doing this to a Run whose Steps are all finished
 * changes nothing, so it is safe to call before every `advance`.
 */
export async function resumeRun(
  runId: string,
  { runs, tasks, workspaces }: ResumeRunOptions,
): Promise<ResumedRun> {
  const run = runs.getRun(runId);
  if (!run) throw new Error(`No Run ${runId} to resume.`);
  if (FINISHED.has(run.status))
    throw new Error(
      `Run ${runId} is ${run.status}; there is nothing left to resume.`,
    );
  // The Step's own record goes first: whatever happens next, nothing must read
  // a Step that was interrupted as if it had finished.
  const discarded = tasks.discardRunningSteps(runId);
  // The run branch only moves forward by a Slice Commit, so it is already at
  // the last Slice that passed; only the worktrees can be half-written.
  await workspaces.discardUnfinished();
  return {
    run,
    discardedSteps: discarded.length,
    hadCheckpoint: runs.latestCheckpoint(runId) !== null,
  };
}

/** Every unfinished Run, oldest first, as a restart finds them. */
export function resumableRuns(runs: RunStore): Run[] {
  return runs.listUnfinishedRuns();
}

const FINISHED = new Set(["done", "failed", "aborted"]);
