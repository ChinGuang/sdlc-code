/**
 * The Run page's decisions: a tab for each Gate, the Escalation dialog that
 * opens by itself, and the Run as a decision left it.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RunDetail } from "../api/types.js";
import type { RunTab } from "../router.js";
import { DETAIL, fakeApi } from "../testing/fakeApi.js";
import {
  AT_DESIGN_GATE,
  AT_PR_GATE,
  CONTENTS,
  ESCALATED,
} from "../testing/gateFixtures.js";
import { RunPage } from "./RunPage.js";

async function open(detail: RunDetail, tab: RunTab = "overview") {
  const fake = fakeApi({ detail, documents: CONTENTS });
  render(<RunPage api={fake.api} runId={detail.id} tab={tab} />);
  await screen.findByRole("heading", { level: 1 });
  return fake;
}

const tabs = () => within(screen.getByRole("navigation", { name: "Run" }));

describe("RunPage: its tabs", () => {
  it("links each tab, and marks the one shown", async () => {
    await open(DETAIL, "review");

    expect(tabs().getByRole("link", { name: "Overview" })).toHaveAttribute(
      "href",
      `#/runs/${DETAIL.id}`,
    );
    expect(tabs().getByRole("link", { name: "Design Gate" })).toHaveAttribute(
      "href",
      `#/runs/${DETAIL.id}/design-gate`,
    );
    expect(
      tabs().getByRole("link", { name: "Code Review & PR" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("sends a person from the Overview to the Gate that waits for them", async () => {
    await open(AT_DESIGN_GATE);

    expect(
      screen.getByRole("link", { name: "Review the documents" }),
    ).toHaveAttribute("href", `#/runs/${DETAIL.id}/design-gate`);
  });

  it("shows the Design Gate on its tab", async () => {
    await open(AT_DESIGN_GATE, "designGate");

    expect(
      screen.getByRole("button", { name: "Submit verdicts" }),
    ).toBeInTheDocument();
  });

  it("shows the PR Gate on the Code Review tab, and the Run it leaves", async () => {
    const fake = await open(AT_PR_GATE, "review");
    fake.setDetail({
      ...AT_PR_GATE,
      status: "done",
      waiting: { for: "nothing" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(
      await screen.findByText("Done", { selector: ".badge" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});

describe("RunPage: an Escalation", () => {
  it("opens its dialog by itself, puts it aside on Cancel, and brings it back", async () => {
    await open(ESCALATED);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Decide…" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  // Cancel put aside that Escalation, not every one to come.
  it("opens again by itself for the next Escalation", async () => {
    const fake = await open(ESCALATED);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // The Run is escalated again, for another reason; the page hears of it.
    fake.setDetail({
      ...ESCALATED,
      waiting: {
        ...ESCALATED.waiting,
        id: "escalation-2",
        trigger: "tokenBudget",
        summary: "The Token Budget is spent.",
      } as RunDetail["waiting"],
      lastSeq: 200,
    });
    act(() => void fake.push({ type: "status", status: "escalated" }));

    expect(await screen.findByRole("dialog")).toHaveAccessibleName(
      /Token Budget spent/,
    );
  });

  // The loop a person found: the retry went through, the Run stopped again
  // at once at an Escalation that read the same, and the dialog sat still.
  it("says so when the Run stops again right after a decision", async () => {
    const fake = await open(ESCALATED);
    fake.setDetail({
      ...ESCALATED,
      waiting: {
        ...ESCALATED.waiting,
        id: "escalation-2",
      } as RunDetail["waiting"],
    });

    fireEvent.click(screen.getByRole("radio", { name: /Skip this slice/ }));
    fireEvent.click(screen.getByRole("button", { name: "Skip slice" }));

    expect(
      await screen.findByText(
        "Your decision went through, but the Run stopped again.",
      ),
    ).toBeInTheDocument();
    // A fresh dialog: nothing chosen, nothing waiting on a reply.
    expect(
      screen.getByRole("radio", { name: /Skip this slice/ }),
    ).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Choose one" })).toBeDisabled();
  });

  it("offers Decide… on every tab while it waits", async () => {
    await open(ESCALATED, "review");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Decide…" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes once the decision moves the Run on", async () => {
    const fake = await open(ESCALATED);
    fake.setDetail({
      ...ESCALATED,
      status: "building",
      waiting: { for: "nothing" },
    });

    fireEvent.click(screen.getByRole("radio", { name: /Skip this slice/ }));
    fireEvent.click(screen.getByRole("button", { name: "Skip slice" }));

    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.calls.decisions).toEqual([
      { escalation: { choice: "skipSlice" } },
    ]);
  });
});
