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

function open(run: RunDetail = ESCALATED) {
  const fake = fakeApi({ detail: run });
  const onDecided = vi.fn<(detail: RunDetail) => void>();
  const onClose = vi.fn();
  render(
    <EscalationDialog
      run={run}
      api={fake.api}
      onDecided={onDecided}
      onClose={onClose}
    />,
  );
  return { ...fake, onDecided, onClose };
}

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

  it("decides nothing until a way on is chosen, and Cancel only closes it", () => {
    const { calls, onClose } = open();

    expect(screen.getByRole("button", { name: "Choose one" })).toBeDisabled();
    confirm("Cancel");

    expect(onClose).toHaveBeenCalledOnce();
    expect(calls.decisions).toEqual([]);
  });
});
