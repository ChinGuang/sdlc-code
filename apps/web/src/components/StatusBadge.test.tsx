/**
 * Every Run status as a person reads it: blue while agents work, amber or
 * purple while a person is needed, red when it stopped.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunStatus, RunSummary } from "../api/types.js";
import { StatusBadge } from "./StatusBadge.js";

const PR = { number: 7, url: "https://github.com/o/r/pull/7", draft: false };

describe("StatusBadge", () => {
  it.each<[RunStatus, RunSummary["pullRequest"], string, string]>([
    ["designing", null, "Designing", "blue"],
    ["awaitingDesignGate", null, "Awaiting Design Gate", "amber"],
    ["building", null, "Coding", "blue"],
    ["reviewing", null, "Code Review", "blue"],
    ["awaitingPrGate", PR, "Awaiting PR Gate", "purple"],
    ["escalated", null, "Escalated", "red"],
    ["done", PR, "Done", "green"],
    ["done", { ...PR, draft: true }, "Draft PR", "muted"],
    ["failed", null, "Failed", "red"],
    ["failed", { ...PR, draft: true }, "Failed · Draft PR", "red"],
    ["aborted", null, "Aborted", "muted"],
    ["aborted", { ...PR, draft: true }, "Aborted · Draft PR", "muted"],
  ])("shows %s (PR %o) as %s in %s", (status, pullRequest, label, tone) => {
    render(<StatusBadge run={{ status, pullRequest }} />);

    const badge = screen.getByText(label);
    expect(badge).toHaveAttribute("data-tone", tone);
    expect(badge).toHaveClass(`tone-${tone}`);
  });

  // Board 02's pill: "Coding · Slice 2".
  it("adds where the Run is, when it is given", () => {
    render(
      <StatusBadge
        run={{ status: "building", pullRequest: null }}
        detail="Slice 2"
      />,
    );

    expect(screen.getByText("Coding · Slice 2")).toBeInTheDocument();
  });
});
