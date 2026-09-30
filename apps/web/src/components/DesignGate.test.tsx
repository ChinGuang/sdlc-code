/**
 * Board 03: a Verdict on every document in review before anything is sent,
 * comments with every change asked for, and the Stale warning shown before a
 * change to a System Design document is sent, not after.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RunDetail } from "../api/types.js";
import { fakeApi } from "../testing/fakeApi.js";
import { AT_DESIGN_GATE, CONTENTS } from "../testing/gateFixtures.js";
import { DesignGate } from "./DesignGate.js";

function open(run: RunDetail = AT_DESIGN_GATE, refuse?: Error) {
  const fake = fakeApi({ detail: run, documents: CONTENTS, refuse });
  const onDecided = vi.fn<(detail: RunDetail) => void>();
  render(<DesignGate run={run} api={fake.api} onDecided={onDecided} />);
  return { ...fake, onDecided };
}

const documents = () =>
  within(screen.getByRole("region", { name: "Documents" }));
const verdict = () =>
  within(screen.getByRole("region", { name: "Your verdict" }));
const submit = () => screen.getByRole("button", { name: "Submit verdicts" });

function choose(
  name: string,
  decision: "Approve" | "Request changes",
  comments?: string,
) {
  fireEvent.click(
    documents().getByRole("button", { name: new RegExp(`^${name}`) }),
  );
  fireEvent.click(verdict().getByRole("button", { name: decision }));
  if (comments !== undefined)
    fireEvent.change(verdict().getByLabelText("Comments"), {
      target: { value: comments },
    });
}

describe("DesignGate", () => {
  it("lists every document with its owner and status, and shows the one chosen", async () => {
    const { calls } = open();

    expect(documents().getAllByRole("button")).toHaveLength(4);
    expect(documents().getAllByText("In review")).toHaveLength(4);
    expect(
      await screen.findByText(/# systemDesign/, { selector: "pre" }),
    ).toBeInTheDocument();

    fireEvent.click(documents().getByRole("button", { name: /API Contract/ }));

    expect(
      await screen.findByText(/# apiContract/, { selector: "pre" }),
    ).toBeInTheDocument();
    expect(calls.documents).toEqual(["systemDesign", "apiContract"]);
  });

  it("sends nothing until every document in review has a Verdict", () => {
    open();

    expect(submit()).toBeDisabled();
    choose("System Design", "Approve");
    choose("API Contract", "Approve");
    choose("UI Spec", "Approve");
    expect(submit()).toBeDisabled();

    choose("Penpot design", "Approve");
    expect(submit()).toBeEnabled();
  });

  it("asks for comments with every change requested", () => {
    open();
    for (const name of ["System Design", "UI Spec", "Penpot design"])
      choose(name, "Approve");

    choose("API Contract", "Request changes");
    expect(submit()).toBeDisabled();
    expect(submit()).toHaveAccessibleDescription(
      "Say what should change in the API Contract.",
    );

    choose("API Contract", "Request changes", "Add rate limiting to login.");
    expect(submit()).toBeEnabled();
  });

  // The Gate's warning: before the person sends it, not after.
  it("warns which documents go Stale when a System Design document changes", () => {
    open();

    choose("API Contract", "Approve");
    expect(verdict().queryByRole("status")).toBeNull();

    choose("API Contract", "Request changes");
    const warning = verdict().getByRole("status");
    expect(warning).toHaveTextContent("2 documents will go stale");
    expect(warning).toHaveTextContent(
      "UI Spec and Penpot design will be redone by the UI Design Agent after the System Design Agent updates the API Contract.",
    );
    expect(
      screen.getByText("0 approved · 1 changes requested · 2 stale"),
    ).toBeInTheDocument();
  });

  // A document whose own changes are asked for is redone, not made Stale.
  it("warns only of what goes Stale, and agrees with the header", () => {
    open();

    choose("UI Spec", "Request changes", "Bigger buttons.");
    choose("API Contract", "Request changes", "Add rate limiting.");

    expect(verdict().getByRole("status")).toHaveTextContent(
      "1 document will go stale",
    );
    expect(verdict().getByRole("status")).toHaveTextContent(
      /^⚠ 1 document will go stale\s*Penpot design will be redone/,
    );
    expect(
      screen.getByText("0 approved · 2 changes requested · 1 stale"),
    ).toBeInTheDocument();
  });

  it("gives no warning for changes to a document nothing is built on", () => {
    open();

    choose("UI Spec", "Request changes");

    expect(verdict().queryByRole("status")).toBeNull();
    expect(verdict().getByText("UI Design Agent")).toBeInTheDocument();
  });

  it("sends one Verdict per document, and takes the Run it answers with", async () => {
    const { calls, onDecided } = open();
    choose("System Design", "Approve");
    choose("API Contract", "Request changes", "  Add rate limiting.  ");
    choose("UI Spec", "Approve", "Nice.");
    choose("Penpot design", "Approve");

    fireEvent.click(submit());

    await vi.waitFor(() => expect(onDecided).toHaveBeenCalledOnce());
    expect(calls.decisions).toEqual([
      {
        designGate: [
          { documentKind: "systemDesign", decision: "approve", comments: "" },
          {
            documentKind: "apiContract",
            decision: "requestChanges",
            comments: "Add rate limiting.",
          },
          { documentKind: "uiSpec", decision: "approve", comments: "Nice." },
          { documentKind: "penpotDesign", decision: "approve", comments: "" },
        ],
      },
    ]);
  });

  it("shows why the server refused the Verdicts", async () => {
    const { onDecided } = open(
      AT_DESIGN_GATE,
      new Error("Run has no open Design Gate."),
    );
    for (const name of [
      "System Design",
      "API Contract",
      "UI Spec",
      "Penpot design",
    ])
      choose(name, "Approve");

    fireEvent.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Run has no open Design Gate.",
    );
    expect(onDecided).not.toHaveBeenCalled();
  });

  it("asks nothing of a Run that is not at the Gate", () => {
    open({
      ...AT_DESIGN_GATE,
      status: "building",
      waiting: { for: "nothing" },
      documents: AT_DESIGN_GATE.documents.map((document) => ({
        ...document,
        status: "approved",
      })),
    });

    expect(
      screen.queryByRole("button", { name: "Submit verdicts" }),
    ).toBeNull();
    expect(verdict().getByText(/nothing to decide/)).toBeInTheDocument();
  });
});
