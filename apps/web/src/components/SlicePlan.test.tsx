/**
 * The Slice plan: approved only once its document is, and the current Slice's
 * lanes saying what each Coding Agent is doing, which a running Task alone
 * does not tell.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunDetail, RunTask } from "../api/types.js";
import { DETAIL } from "../testing/fakeApi.js";
import { SlicePlan } from "./SlicePlan.js";

const running = (
  role: RunTask["role"],
  stepStatus: "running" | "completed",
): RunTask => ({
  id: role,
  sliceId: "s2",
  role,
  status: "running",
  retriesSpent: 0,
  steps: [
    {
      id: `${role}-step`,
      status: stepStatus,
      startedAt: "2026-09-29T09:00:00.000Z",
      endedAt: stepStatus === "running" ? null : "2026-09-29T09:05:00.000Z",
    },
  ],
});

function lane(name: string) {
  return within(screen.getByLabelText(name));
}

describe("SlicePlan", () => {
  it("calls the plan approved only once its document is", () => {
    const { rerender } = render(<SlicePlan run={DETAIL} />);
    expect(screen.getByText("3 slices")).toBeInTheDocument();

    const approved: RunDetail = {
      ...DETAIL,
      documents: [{ kind: "slicePlan", version: 1, status: "approved" }],
    };
    rerender(<SlicePlan run={approved} />);
    expect(
      screen.getByText("Approved at Design Gate · 3 slices"),
    ).toBeInTheDocument();
  });

  it("says a lane writes code only while it has a Step running", () => {
    render(
      <SlicePlan
        run={{
          ...DETAIL,
          tasks: [
            running("backendCoding", "running"),
            running("frontendCoding", "completed"),
          ],
        }}
      />,
    );

    expect(lane("Backend Coding Agent").getByText("Writing code")).toBeTruthy();
    expect(
      lane("Frontend Coding Agent").getByText("Between Steps"),
    ).toBeTruthy();
  });

  it("says the lanes wait for the Test Run, or for a person", () => {
    const testing = DETAIL.slices.map((slice) =>
      slice.id === "s2" ? { ...slice, status: "testing" as const } : slice,
    );
    const tasks = [running("backendCoding", "completed")];
    const { rerender } = render(
      <SlicePlan run={{ ...DETAIL, slices: testing, tasks }} />,
    );
    expect(
      lane("Backend Coding Agent").getByText("Waiting for the Test Run"),
    ).toBeTruthy();

    rerender(<SlicePlan run={{ ...DETAIL, status: "escalated", tasks }} />);
    expect(
      lane("Backend Coding Agent").getByText("Waiting for a person"),
    ).toBeTruthy();
  });

  it("shows the Retry Budget spent since the last hint", () => {
    render(
      <SlicePlan
        run={{
          ...DETAIL,
          tasks: [{ ...running("backendCoding", "running"), retriesSpent: 2 }],
        }}
      />,
    );

    expect(screen.getByText("Retry 2/3")).toBeInTheDocument();
  });
});
