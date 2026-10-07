// SPDX-License-Identifier: MPL-2.0
/**
 * Which Slices are built together (S5). The first Slice that has not passed is
 * always built, as before. Others join it only when the Slice Plan says they
 * depend on nothing unbuilt: a Slice with no `dependsOn` follows every Slice
 * before it, and every Slice waits for the Walking Skeleton.
 */
import type { DesignSlice } from "../agents/systemDesign/design.js";
import type { Slice } from "../domain/entities.js";

const UNFINISHED = new Set<Slice["status"]>(["pending", "building", "testing"]);

/** At most `max` Slices, in plan order, the first of them the one to build next. */
export function nextBatch(
  slices: readonly Slice[],
  plan: readonly DesignSlice[],
  max: number,
): Slice[] {
  const current = slices.find(
    (slice) => slice.status !== "passed" && slice.status !== "skipped",
  );
  if (!current) return [];
  const batch = [current];
  if (max <= 1) return batch;
  const passed = new Set(
    slices.filter((slice) => slice.status === "passed").map((s) => s.title),
  );
  const skeleton = slices.find((slice) => slice.isWalkingSkeleton);
  if (skeleton && !passed.has(skeleton.title)) return batch;
  for (const slice of slices) {
    if (batch.length >= max) break;
    if (slice === current || !UNFINISHED.has(slice.status)) continue;
    const dependsOn = plan.find((one) => one.title === slice.title)?.dependsOn;
    // Said nothing: it follows every Slice before it, so it waits its turn.
    if (dependsOn === undefined) continue;
    if (dependsOn.every((title) => passed.has(title))) batch.push(slice);
  }
  return batch;
}
