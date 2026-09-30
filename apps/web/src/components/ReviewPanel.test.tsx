/**
 * Board 04: every Finding of the last review with the Rule it cites, and the
 * PR Gate's two answers.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RunDetail } from "../api/types.js";
import { fakeApi } from "../testing/fakeApi.js";
import { AT_PR_GATE } from "../testing/gateFixtures.js";
import { ReviewPanel } from "./ReviewPanel.js";

function open(run: RunDetail = AT_PR_GATE) {
  const fake = fakeApi({ detail: run });
  const onDecided = vi.fn<(detail: RunDetail) => void>();
  render(
    <ReviewPanel
      run={run}
      testRun={null}
      api={fake.api}
      onDecided={onDecided}
    />,
  );
  return { ...fake, onDecided };
}

const findings = () => within(screen.getByRole("region", { name: "Findings" }));

describe("ReviewPanel", () => {
  it("lists the last review's Findings with their Rules, severities and places", () => {
    open();

    const items = findings().getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("REUSE-01");
    expect(items[0]).toHaveTextContent("major");
    expect(items[0]).toHaveTextContent("src/server/notes.ts:42");
    expect(items[0]).toHaveTextContent("→ Extract to packages/shared/tags.ts.");
    expect(items[0]).toHaveTextContent("In PR description");
    // A Finding about the whole file has no line.
    expect(items[1]).toHaveTextContent("src/server/routes.ts");
    expect(items[1]).not.toHaveTextContent("routes.ts:0");
  });

  it("filters by severity", () => {
    open();

    fireEvent.click(findings().getByRole("button", { name: "Minor 1" }));

    expect(findings().getAllByRole("listitem")).toHaveLength(1);
    expect(findings().getByText("Leftover console.log")).toBeInTheDocument();
  });

  it("counts the Findings, and what an earlier review sent back", () => {
    open();

    const summary = (name: string) =>
      screen.getByRole("region", { name: `${name} summary` });
    expect(summary("Findings")).toHaveTextContent("0 · 1 · 1");
    expect(summary("Linters")).toHaveTextContent("1 found");
    expect(summary("Slices")).toHaveTextContent("3 / 3all passed");
    expect(screen.getByText("1 sent back to be fixed")).toBeInTheDocument();
  });

  it("approves the pull request", async () => {
    const { calls, onDecided } = open();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await vi.waitFor(() => expect(onDecided).toHaveBeenCalledOnce());
    expect(calls.decisions).toEqual([{ prGate: { choice: "approve" } }]);
  });

  it("sends it back only with what should change", async () => {
    const { calls } = open();

    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    const send = screen.getByRole("button", { name: "Send back" });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText("What should change"), {
      target: { value: "Rename the tags route." },
    });
    fireEvent.click(send);

    await vi.waitFor(() => expect(calls.decisions).toHaveLength(1));
    expect(calls.decisions).toEqual([
      {
        prGate: {
          choice: "requestChanges",
          comments: "Rename the tags route.",
        },
      },
    ]);
  });

  // A review whose attempts ran out escalated; nothing reached a pull request.
  it("says a blocking Finding escalated when the review stopped the Run", () => {
    open({
      ...AT_PR_GATE,
      status: "escalated",
      pullRequest: null,
      reviews: [
        {
          ...AT_PR_GATE.reviews[0]!,
          findings: [
            ...AT_PR_GATE.reviews[0]!.findings,
            AT_PR_GATE.reviews[1]!.findings[0]!,
          ],
        },
      ],
      waiting: {
        for: "escalation",
        trigger: "retryBudget",
        summary: "The review still refuses the code after 3 attempts.",
        slice: null,
        reports: [],
        workingMemory: [],
        openDraftPrOnAbort: true,
      },
    });

    const items = findings().getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Escalated");
    expect(items[1]).toHaveTextContent("Not delivered yet");
  });

  it("offers no decision to a Run that is not at the PR Gate", () => {
    open({
      ...AT_PR_GATE,
      status: "reviewing",
      reviews: [],
      waiting: { for: "nothing" },
    });

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText(/Not reviewed yet/)).toBeInTheDocument();
  });
});
