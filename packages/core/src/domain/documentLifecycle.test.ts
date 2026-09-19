import { describe, expect, it } from "vitest";
import {
  DOCUMENT_EVENTS,
  DOCUMENT_STATUSES,
  documentsMadeStale,
  nextDocumentStatus,
  type DocumentEvent,
  type DocumentKind,
  type DocumentStatus,
} from "./documentLifecycle.js";
import { IllegalTransitionError } from "./runLifecycle.js";

/** Every legal transition in UML diagram 4; anything not listed is illegal. */
const LEGAL: Array<[DocumentStatus, DocumentEvent, DocumentStatus]> = [
  ["drafting", "ownerFinished", "inReview"],
  ["inReview", "approved", "approved"],
  ["inReview", "changesRequested", "changesRequested"],
  ["changesRequested", "ownerRevises", "drafting"],
  ["approved", "changedAfterApproval", "drafting"],
  ["approved", "upstreamChanged", "stale"],
  ["inReview", "upstreamChanged", "stale"],
  ["stale", "redo", "drafting"],
];

describe("nextDocumentStatus", () => {
  it.each(LEGAL)("%s + %s → %s", (status, event, expected) => {
    expect(nextDocumentStatus(status, event)).toBe(expected);
  });

  const legal = new Set(LEGAL.map(([s, e]) => `${s}+${e}`));
  const illegal = DOCUMENT_STATUSES.flatMap((status) =>
    DOCUMENT_EVENTS.filter((event) => !legal.has(`${status}+${event}`)).map(
      (event): [DocumentStatus, DocumentEvent] => [status, event],
    ),
  );

  it(`rejects all ${illegal.length} other combinations`, () => {
    for (const [status, event] of illegal) {
      expect(
        () => nextDocumentStatus(status, event),
        `${status}+${event}`,
      ).toThrow(IllegalTransitionError);
    }
  });
});

describe("documentsMadeStale", () => {
  const all = (
    status: DocumentStatus,
  ): Record<DocumentKind, DocumentStatus> => ({
    systemDesign: status,
    slicePlan: status,
    apiContract: status,
    uiSpec: status,
    penpotDesign: status,
  });

  it.each(["systemDesign", "slicePlan", "apiContract"] as const)(
    "a change to %s makes the UI Spec and Penpot design Stale",
    (changed) => {
      expect(documentsMadeStale(changed, all("approved"))).toEqual([
        "uiSpec",
        "penpotDesign",
      ]);
    },
  );

  it.each(["uiSpec", "penpotDesign"] as const)(
    "a change to %s makes nothing Stale",
    (changed) => {
      expect(documentsMadeStale(changed, all("approved"))).toEqual([]);
    },
  );

  it("only affects documents in review or approved", () => {
    expect(
      documentsMadeStale("apiContract", {
        ...all("approved"),
        uiSpec: "drafting",
        penpotDesign: "inReview",
      }),
    ).toEqual(["penpotDesign"]);
  });
});
