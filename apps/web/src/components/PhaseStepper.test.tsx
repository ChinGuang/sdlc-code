/**
 * The phase stepper as each kind of Run shows it: done up to where it is, the
 * gates skipped in auto mode, and a stopped Run marked where it stopped.
 */
import { render, screen, within } from "@testing-library/react";
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

const FOUR = [
  slice("a", "passed"),
  slice("b", "building"),
  slice("c", "pending"),
  slice("d", "pending"),
];

function states(run: Pick<RunDetail, "status" | "mode" | "slices">) {
  render(<PhaseStepper run={run} />);
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

  it("says which phase is current to a screen reader", () => {
    render(
      <PhaseStepper run={{ status: "designing", mode: "gated", slices: [] }} />,
    );

    expect(screen.getByText("Design").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });
});
