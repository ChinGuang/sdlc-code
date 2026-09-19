/**
 * Slice progress inside the Run's "building" status (UML diagram 3, Building):
 * in progress → testing → committed, back to building when an issue is routed,
 * or skipped by a human at an Escalation.
 */
import type { SliceStatus } from "./entities.js";
import { IllegalTransitionError } from "./runLifecycle.js";

const ALLOWED: Record<SliceStatus, readonly SliceStatus[]> = {
  pending: ["building", "skipped"],
  building: ["testing", "skipped"],
  testing: ["building", "passed", "skipped"],
  passed: [],
  skipped: [],
};

/** Throws IllegalTransitionError unless a Slice may move from `from` to `to`. */
export function assertSliceMove(from: SliceStatus, to: SliceStatus): void {
  if (!ALLOWED[from].includes(to))
    throw new IllegalTransitionError("Slice", from, `move to ${to}`);
}
