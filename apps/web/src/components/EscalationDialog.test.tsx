/**
 * Board 05: what stopped the Run, and the four ways on. Aborting carries the
 * Draft PR checkbox as the person left it.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EscalationBrief, RunDetail } from "../api/types.js";
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

/** The fixture's Escalation, with its brief written. */
const escalatedWith = (brief: EscalationBrief): RunDetail => ({
  ...ESCALATED,
  waiting: { ...ESCALATED.waiting, brief } as RunDetail["waiting"],
});

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

  it("shows the brief, and its hint fills the box ready to send (T24c)", async () => {
    const { calls } = open(
      escalatedWith({
        facts: ["server/app.ts no longer exports createApp, route."],
        analysis: {
          failing: "Every backend test fails to load.",
          tried: "The backend rewrote server/app.ts.",
          cause: "server/app.ts dropped the template's createApp.",
          choice: "retryWithHint",
          hint: "Restore createApp and route in server/app.ts.",
        },
        withoutAnalysis: null,
      }),
    );

    const brief = screen.getByRole("region", { name: "What went wrong" });
    expect(brief).toHaveTextContent("Every backend test fails to load.");
    expect(brief).toHaveTextContent(
      "server/app.ts dropped the template's createApp.",
    );
    expect(brief).toHaveTextContent(
      "server/app.ts no longer exports createApp, route.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Use this hint" }));

    expect(
      screen.getByRole("radio", { name: /Retry with a hint/ }),
    ).toBeChecked();
    expect(screen.getByLabelText("Hint for the agents")).toHaveValue(
      "Restore createApp and route in server/app.ts.",
    );
    confirm("Retry with hint");
    await vi.waitFor(() => expect(calls.decisions).toHaveLength(1));
    expect(calls.decisions[0]).toMatchObject({
      escalation: {
        choice: "retryWithHint",
        hint: "Restore createApp and route in server/app.ts.",
      },
    });
  });

  it("says why a brief has no analysis, and still shows its facts", () => {
    open(
      escalatedWith({
        facts: [
          "The Token Budget is spent: 5,002,759 of 5,000,000 tokens used.",
        ],
        analysis: null,
        withoutAnalysis:
          "The Token Budget is spent, so no analysis was made: raise it to go on.",
      }),
    );

    const brief = screen.getByRole("region", { name: "What went wrong" });
    expect(brief).toHaveTextContent("no analysis was made");
    expect(brief).toHaveTextContent("5,002,759 of 5,000,000");
    expect(screen.queryByRole("button", { name: "Use this hint" })).toBeNull();
  });

  it("says a brief is on its way while the Run is still advancing", () => {
    open({ ...ESCALATED, advancing: true });

    expect(screen.getByRole("status")).toHaveTextContent("Writing a brief");
  });

  it("shows the cause a report carries under its error", () => {
    open({
      ...ESCALATED,
      waiting: {
        ...ESCALATED.waiting,
        reports: [
          {
            step: "unit",
            failingTest: null,
            file: "prisma/schema.prisma",
            endpoint: null,
            error: "Error: Prisma schema validation - (get-dmmf wasm)",
            cause:
              "error: Native type VarChar is not supported for sqlite connector. / --> prisma/schema.prisma:19",
            suspectedOwner: "backendCoding",
            occurrences: 1,
          },
        ],
      } as RunDetail["waiting"],
    });

    expect(
      screen.getByText(/Native type VarChar is not supported/),
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
          // The fixture's one report suspects the backend.
          side: "backend",
        },
      },
    ]);
  });

  // Run #e29ca700: frontend hints also ran, and confused, the backend.
  it("sends the hint where the evidence points, or where the person says (T24i)", async () => {
    const { calls } = open();

    pick(/Retry with a hint/);
    const sides = screen.getByRole("group", { name: "Send the hint to" });
    expect(
      within(sides).getByRole("radio", { name: /Backend Coding Agent/ }),
    ).toBeChecked();
    expect(sides).toHaveTextContent("(where the evidence points)");
    fireEvent.click(
      within(sides).getByRole("radio", { name: /Frontend Coding Agent/ }),
    );
    expect(sides).toHaveTextContent("Only the frontend codes");
    fireEvent.change(screen.getByLabelText("Hint for the agents"), {
      target: { value: "Use getJson." },
    });
    confirm("Retry with hint");

    await vi.waitFor(() => expect(calls.decisions).toHaveLength(1));
    expect(calls.decisions[0]).toEqual({
      escalation: {
        choice: "retryWithHint",
        hint: "Use getJson.",
        side: "frontend",
      },
    });
  });

  it("offers no side in review, where no Slice is being built", () => {
    open({
      ...ESCALATED,
      waiting: {
        ...ESCALATED.waiting,
        slice: null,
        reports: [],
      } as RunDetail["waiting"],
    });

    pick(/Retry with a hint/);

    expect(
      screen.queryByRole("group", { name: "Send the hint to" }),
    ).toBeNull();
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

    expect(screen.queryByRole("checkbox", { name: "UI design" })).toBeNull();
    expect(
      screen.getByText(/edit the UI Spec to change the UI design/),
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
