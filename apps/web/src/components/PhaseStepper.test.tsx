/**
 * The phase stepper as each kind of Run shows it: done up to where it is, the
 * gates skipped in auto mode, and a stopped Run marked where it stopped.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunDetail, RunSlice } from "../api/types.js";
import { PhaseStepper } from "./PhaseStepper.js";

const slice = (id: string, status: RunSlice["status"]): RunSlice => ({
  id,
  title: id,
  status,
  isWalkingSkeleton: false,
  commitSha: status === "passed" ? "abc1234" : null,
});

const PR = { number: 7, url: "https://github.com/o/r/pull/7", draft: false };

const FOUR = [
  slice("a", "passed"),
  slice("b", "building"),
  slice("c", "pending"),
  slice("d", "pending"),
];

type Shown = Pick<RunDetail, "status" | "mode" | "slices">;

function states(
  run: Shown & Partial<Pick<RunDetail, "pullRequest" | "failure">>,
) {
  render(<PhaseStepper run={{ pullRequest: PR, failure: null, ...run }} />);
  return within(screen.getByRole("list", { name: "Phases" }))
    .getAllByRole("listitem")
    .map((item) => item.getAttribute("data-state"));
}

describe("PhaseStepper", () => {
  it("marks the phases before a building Run done, and Slices current", () => {
    expect(states({ status: "building", mode: "gated", slices: FOUR })).toEqual(
      ["done", "done", "current", "upcoming", "upcoming"],
    );
    expect(screen.getByText("Slices 1/4")).toBeInTheDocument();
  });

  it("waits at the Design Gate", () => {
    expect(
      states({ status: "awaitingDesignGate", mode: "gated", slices: [] }),
    ).toEqual(["done", "current", "upcoming", "upcoming", "upcoming"]);
  });

  // An auto Run never waits for a person.
  it("skips both gates in auto mode", () => {
    expect(states({ status: "reviewing", mode: "auto", slices: FOUR })).toEqual(
      ["done", "skipped", "done", "current", "skipped"],
    );
  });

  it("marks every phase done when the Run is", () => {
    expect(states({ status: "done", mode: "gated", slices: FOUR })).toEqual(
      Array(5).fill("done"),
    );
  });

  it("marks where an escalated Run stopped: in its Slices", () => {
    expect(
      states({ status: "escalated", mode: "gated", slices: FOUR }),
    ).toEqual(["done", "done", "stopped", "upcoming", "upcoming"]);
  });

  it("marks a Run that failed before any Slice as stopped in Design", () => {
    expect(states({ status: "failed", mode: "auto", slices: [] })).toEqual([
      "stopped",
      "skipped",
      "upcoming",
      "upcoming",
      "skipped",
    ]);
  });

  it("marks a Run stopped after every Slice as stopped in Code Review", () => {
    const through = [slice("a", "passed"), slice("b", "skipped")];
    expect(
      states({ status: "escalated", mode: "gated", slices: through }),
    ).toEqual(["done", "done", "done", "stopped", "upcoming"]);
  });

  // The Slice Plan is saved while designing, before any Slice starts.
  it("marks a design that failed after planning as stopped in Design", () => {
    const planned = [slice("a", "pending"), slice("b", "pending")];
    expect(states({ status: "failed", mode: "auto", slices: planned })).toEqual(
      ["stopped", "skipped", "upcoming", "upcoming", "skipped"],
    );
    cleanup();
    expect(
      states({
        status: "failed",
        mode: "auto",
        slices: planned,
        failure: { trigger: "design", summary: "no design", slice: null },
      })[0],
    ).toBe("stopped");
  });

  // Nothing to deliver: no pull request was opened, so no PR Gate was held.
  it("skips the PR Gate of a Run that finished with no pull request", () => {
    expect(
      states({
        status: "done",
        mode: "gated",
        slices: FOUR,
        pullRequest: null,
      }),
    ).toEqual(["done", "done", "done", "done", "skipped"]);
  });

  it("marks a gated design that failed as stopped in Design", () => {
    expect(
      states({
        status: "designing",
        mode: "gated",
        slices: [],
        failure: {
          trigger: "design",
          summary: "No valid design.",
          slice: null,
        },
      })[0],
    ).toBe("stopped");
  });

  it("says which phase is current to a screen reader", () => {
    render(
      <PhaseStepper
        run={{
          status: "designing",
          mode: "gated",
          slices: [],
          pullRequest: null,
          failure: null,
        }}
      />,
    );

    expect(screen.getByText("Design").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });
});
