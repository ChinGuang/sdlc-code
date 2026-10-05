// SPDX-License-Identifier: MPL-2.0
/**
 * What each agent working on a Slice last wrote (CONTEXT.md "Working
 * Memory"): what it tried. The Escalation dialog and the Escalation Brief
 * read the same notes, so a person and the brief never see different ones.
 */
import type { AgentRole } from "../agentRoles.js";
import type { SliceStore } from "../persistence/sliceStore.js";
import type { TaskStore } from "../persistence/taskStore.js";

export type WorkingMemoryNote = { role: AgentRole; note: string };

/** Each Task's last note in the Slice of that title; none outside a Slice. */
export function lastWorkingMemory(
  stores: { slices: SliceStore; tasks: TaskStore },
  runId: string,
  sliceTitle: string | null,
): WorkingMemoryNote[] {
  const { slices, tasks } = stores;
  const slice = slices
    .listSlices(runId)
    .find((one) => one.title === sliceTitle);
  if (!slice) return [];
  return tasks
    .listTasks(runId)
    .filter((task) => task.sliceId === slice.id)
    .flatMap((task) => {
      const note = tasks
        .listSteps(task.id)
        .findLast((step) => step.workingMemory !== null)?.workingMemory;
      return note ? [{ role: task.agentRole, note }] : [];
    });
}
