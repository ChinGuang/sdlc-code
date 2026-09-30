/**
 * Board 05: what stopped the Run, and the four ways on. Aborting carries the
 * Draft PR checkbox as the person left it.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RunDetail } from "../api/types.js";
import { fakeApi } from "../testing/fakeApi.js";
import { ESCALATED } from "../testing/gateFixtures.js";
import { EscalationDialog } from "./EscalationDialog.js";

function openKeeping(run: RunDetail = ESCALATED) {
  const fake = fakeApi({ detail: run });
  const onDecided = vi.fn<(detail: RunDetail) => void>();
  const onClose = vi.fn();
  const view = render(
    <EscalationDialog
      run={run}
      api={fake.api}
      onDecided={onDecided}
      onClose={onClose}
    />,
  );
  return { ...fake, ...view, onDecided, onClose };
}

const open = openKeeping;

const pick = (name: RegExp) =>
  fireEvent.click(screen.getByRole("radio", { name }));
const confirm = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));

describe("EscalationDialog", () => {
  it("says what stopped the Run, what kept failing and what was tried", () => {
    open();

    expect(
      screen.getByRole("dialog", { name: /Loop detected in Slice 2/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    expect(screen.getByText("612k / 2.0M")).toBeInTheDocument();
    expect(screen.getByText("Repeated issue")).toBeInTheDocument();
    expect(
      screen.getByText(/smoke › POST \/api\/bookings → 409 Conflict/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Tried normalising to UTC; still 409."),
    ).toBeInTheDocument();
  });

  // The plan's criterion: the abort payload carries the checkbox.
  it("aborts with a Draft PR unless the box is unticked", async () => {
    const { calls } = open();

    pick(/Abort run/);
    expect(screen.getByRole("checkbox", { name: /Draft PR/ })).toBeChecked();
    confirm("Abort run");

    await vi.waitFor(() => expect(calls.decisions).toHaveLength(1));
    expect(calls.decisions).toEqual([
      { escalation: { choice: "abort", openDraftPrOnAbort: true } },
    ]);
  });

  it("aborts with no Draft PR when the box is unticked", async () => {
    const { calls, onDecided } = open();

    pick(/Abort run/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Draft PR/ }));
    confirm("Abort run");

    await vi.waitFor(() => expect(onDecided).toHaveBeenCalledOnce());
    expect(calls.decisions).toEqual([
      { escalation: { choice: "abort", openDraftPrOnAbort: false } },
    ]);
  });

  it("retries only with a hint", async () => {
    const { calls } = open();

    pick(/Retry with a hint/);
    expect(
      screen.getByRole("button", { name: "Retry with hint" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Hint for the agents"), {
      target: { value: " Slots are 30 minutes everywhere. " },
    });
    confirm("Retry with hint");

    await vi.waitFor(() => expect(calls.decisions).toHaveLength(1));
    expect(calls.decisions).toEqual([
      {
        escalation: {
          choice: "retryWithHint",
          hint: "Slots are 30 minutes everywhere.",
        },
      },
    ]);
  });

  it("sends the chosen documents back to their owners, with what should change", async () => {
    const { calls } = open();

    pick(/Edit approved documents/);
    fireEvent.click(screen.getByRole("checkbox", { name: "API Contract" }));
    fireEvent.change(screen.getByLabelText("What should change"), {
      target: { value: "Slot length is 30 minutes." },
    });
    confirm("Send to the owners");

    await vi.waitFor(() => expect(calls.decisions).toHaveLength(1));
    expect(calls.decisions).toEqual([
      {
        escalation: {
          choice: "editDocuments",
          edits: [
            {
              documentKind: "apiContract",
              comments: "Slot length is 30 minutes.",
            },
          ],
        },
      },
    ]);
  });

  it("skips the Slice", async () => {
    const { calls } = open();

    pick(/Skip this slice/);
    confirm("Skip slice");

    await vi.waitFor(() => expect(calls.decisions).toHaveLength(1));
    expect(calls.decisions).toEqual([{ escalation: { choice: "skipSlice" } }]);
  });

  it("takes the focus, gives it back, and puts itself aside on Escape", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const { onClose, unmount } = openKeeping();

    expect(screen.getByRole("dialog")).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    unmount();
    expect(outside).toHaveFocus();
    outside.remove();
  });

  // The core redraws the Penpot design from the UI Spec, and refuses it.
  it("never offers the Penpot design to edit", () => {
    open({
      ...ESCALATED,
      documents: [
        ...ESCALATED.documents,
        {
          kind: "penpotDesign",
          version: 1,
          status: "approved",
          ownerAgent: "uiDesign",
          wouldMakeStale: [],
        },
      ],
    });

    fireEvent.click(
      screen.getByRole("radio", { name: /Edit approved documents/ }),
    );

    expect(
      screen.queryByRole("checkbox", { name: "Penpot design" }),
    ).toBeNull();
    expect(
      screen.getByText(/edit the UI Spec to change the Penpot design/),
    ).toBeTruthy();
  });

  // No Slice was being built: the review ran out of attempts.
  it("names a review that stopped, and offers no Slice to skip", () => {
    open({
      ...ESCALATED,
      waiting: {
        ...ESCALATED.waiting,
        trigger: "retryBudget",
        slice: null,
        reports: [],
        workingMemory: [],
      } as RunDetail["waiting"],
    });

    expect(
      screen.getByRole("dialog", {
        name: /The review keeps refusing the code/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /Skip this slice/ }),
    ).toBeDisabled();
    expect(
      screen.getByText("Run the review again with its attempts back"),
    ).toBeInTheDocument();
  });

  // Going on with nothing left to spend stops again at once.
  it("asks for a higher Token Budget when the budget is spent, and sends it", async () => {
    const { calls } = open({
      ...ESCALATED,
      tokensUsed: 2_005_052,
      tokenBudget: 2_000_000,
      waiting: {
        ...ESCALATED.waiting,
        trigger: "tokenBudget",
      } as RunDetail["waiting"],
    });

    pick(/Skip this slice/);
    const budget = screen.getByLabelText(/New Token Budget/);
    expect(budget).toHaveValue("3,000,000");
    fireEvent.change(budget, { target: { value: "1,000,000" } });
    expect(screen.getByRole("button", { name: "Skip slice" })).toBeDisabled();

    fireEvent.change(budget, { target: { value: "2,500,000" } });
    confirm("Skip slice");

    await vi.waitFor(() => expect(calls.decisions).toHaveLength(1));
    expect(calls.decisions).toEqual([
      { escalation: { choice: "skipSlice", tokenBudget: 2_500_000 } },
    ]);
  });

  it("asks for no budget while there is budget left", () => {
    open();

    pick(/Skip this slice/);
    expect(screen.queryByLabelText(/New Token Budget/)).toBeNull();
  });

  it("answers again after a decision, even if the Run stops here again", async () => {
    open();

    pick(/Skip this slice/);
    confirm("Skip slice");

    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Skip slice" })).toBeEnabled(),
    );
  });

  it("says why an option is not there", () => {
    open({ ...ESCALATED, documents: [] });

    expect(
      screen.getByRole("radio", { name: /Edit approved documents/ }),
    ).toBeDisabled();
    expect(
      screen.getByText("No approved documents to edit"),
    ).toBeInTheDocument();
  });

  it("decides nothing until a way on is chosen, and Cancel only closes it", () => {
    const { calls, onClose } = open();

    expect(screen.getByRole("button", { name: "Choose one" })).toBeDisabled();
    confirm("Cancel");

    expect(onClose).toHaveBeenCalledOnce();
    expect(calls.decisions).toEqual([]);
  });
});
