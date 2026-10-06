// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import type { DesignSlice } from "../agents/systemDesign/design.js";
import type { Slice } from "../domain/entities.js";
import { nextBatch } from "./sliceBatch.js";

const planned = (title: string, dependsOn?: string[]): DesignSlice => ({
  title,
  goal: title,
  isWalkingSkeleton: title === "Skeleton",
  endpoints: ["GET /x"],
  ...(dependsOn ? { dependsOn } : {}),
});

const stored = (title: string, status: Slice["status"]): Slice => ({
  id: title,
  runId: "r",
  order: 1,
  title,
  isWalkingSkeleton: title === "Skeleton",
  status,
  commitSha: status === "passed" ? "c" : null,
});

const PLAN = [
  planned("Skeleton"),
  planned("A", []),
  planned("B", []),
  planned("C", ["A"]),
  planned("D"),
];
const titles = (batch: Slice[]) => batch.map((slice) => slice.title);

describe("nextBatch", () => {
  it("is the next Slice alone when nothing may be built together", () => {
    const slices = [
      stored("Skeleton", "passed"),
      stored("A", "pending"),
      stored("B", "pending"),
    ];

    expect(titles(nextBatch(slices, PLAN, 1))).toEqual(["A"]);
  });

  it("is nothing when every Slice has passed or been skipped", () => {
    expect(
      nextBatch(
        [stored("Skeleton", "passed"), stored("A", "skipped")],
        PLAN,
        3,
      ),
    ).toEqual([]);
  });

  it("waits for the Walking Skeleton, whatever the plan says of the others", () => {
    const slices = [
      stored("Skeleton", "pending"),
      stored("A", "pending"),
      stored("B", "pending"),
    ];

    expect(titles(nextBatch(slices, PLAN, 3))).toEqual(["Skeleton"]);
  });

  it("adds the Slices whose dependencies have all passed, in plan order, up to the limit", () => {
    const slices = [
      stored("Skeleton", "passed"),
      stored("A", "pending"),
      stored("B", "pending"),
      stored("C", "pending"),
    ];

    expect(titles(nextBatch(slices, PLAN, 3))).toEqual(["A", "B"]);
    expect(titles(nextBatch(slices, PLAN, 2))).toEqual(["A", "B"]);
    expect(titles(nextBatch(slices, PLAN, 1))).toEqual(["A"]);
  });

  it("does not add a Slice whose dependency is built in the same batch or skipped", () => {
    const slices = [
      stored("Skeleton", "passed"),
      stored("A", "pending"),
      stored("C", "pending"),
    ];
    // C needs A, which is only being built now.
    expect(titles(nextBatch(slices, PLAN, 3))).toEqual(["A"]);
    // A skipped is not A built.
    expect(
      titles(
        nextBatch(
          [
            stored("Skeleton", "passed"),
            stored("A", "skipped"),
            stored("C", "pending"),
          ],
          PLAN,
          3,
        ),
      ),
    ).toEqual(["C"]);
  });

  it("never adds a Slice that said nothing: it follows every Slice before it", () => {
    const slices = [
      stored("Skeleton", "passed"),
      stored("A", "pending"),
      stored("D", "pending"),
    ];

    expect(titles(nextBatch(slices, PLAN, 3))).toEqual(["A"]);
  });

  it("goes on with a Slice that stopped part-way, and adds one that did too", () => {
    const slices = [
      stored("Skeleton", "passed"),
      stored("A", "building"),
      stored("B", "testing"),
    ];

    expect(titles(nextBatch(slices, PLAN, 3))).toEqual(["A", "B"]);
  });
});
