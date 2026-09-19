import { describe, expect, it } from "vitest";
import { SLICE_STATUSES, type SliceStatus } from "./entities.js";
import { IllegalTransitionError } from "./runLifecycle.js";
import { assertSliceMove } from "./sliceLifecycle.js";

const LEGAL: Array<[SliceStatus, SliceStatus]> = [
  ["pending", "building"],
  ["building", "testing"],
  ["testing", "building"],
  ["testing", "passed"],
  ["pending", "skipped"],
  ["building", "skipped"],
  ["testing", "skipped"],
];

describe("assertSliceMove", () => {
  it.each(LEGAL)("allows %s → %s", (from, to) => {
    expect(() => assertSliceMove(from, to)).not.toThrow();
  });

  const legal = new Set(LEGAL.map(([from, to]) => `${from}>${to}`));
  const illegal = SLICE_STATUSES.flatMap((from) =>
    SLICE_STATUSES.filter((to) => !legal.has(`${from}>${to}`)).map(
      (to): [SliceStatus, SliceStatus] => [from, to],
    ),
  );

  it(`rejects all ${illegal.length} other moves`, () => {
    for (const [from, to] of illegal)
      expect(() => assertSliceMove(from, to), `${from}>${to}`).toThrow(
        IllegalTransitionError,
      );
  });
});
