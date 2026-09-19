/** Document lifecycle (UML diagram 4) and the Stale cascade, as pure functions. */
import { IllegalTransitionError } from "./runLifecycle.js";

/**
 * Documents reviewed at the Design Gate. The Penpot design gets a Verdict too,
 * but only the text documents become Approved Documents (see CONTEXT.md).
 */
export const DOCUMENT_KINDS = [
  "systemDesign",
  "slicePlan",
  "apiContract",
  "uiSpec",
  "penpotDesign",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_STATUSES = [
  "drafting",
  "inReview",
  "approved",
  "changesRequested",
  "stale",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_EVENTS = [
  "ownerFinished",
  "approved",
  "changesRequested",
  "ownerRevises",
  "changedAfterApproval",
  "upstreamChanged",
  "redo",
] as const;
export type DocumentEvent = (typeof DOCUMENT_EVENTS)[number];

const TRANSITIONS: Partial<
  Record<DocumentStatus, Partial<Record<DocumentEvent, DocumentStatus>>>
> = {
  drafting: { ownerFinished: "inReview" },
  inReview: {
    approved: "approved",
    changesRequested: "changesRequested",
    upstreamChanged: "stale",
  },
  changesRequested: { ownerRevises: "drafting" },
  approved: { changedAfterApproval: "drafting", upstreamChanged: "stale" },
  stale: { redo: "drafting" },
};

/** The status after `event`; throws IllegalTransitionError if diagram 4 has no such arrow. */
export function nextDocumentStatus(
  status: DocumentStatus,
  event: DocumentEvent,
): DocumentStatus {
  const next = TRANSITIONS[status]?.[event];
  if (!next) throw new IllegalTransitionError("Document", status, event);
  return next;
}

/** The UI Design documents build on the System Design documents (CONTEXT.md "Stale"). */
const DOWNSTREAM: Record<DocumentKind, DocumentKind[]> = {
  systemDesign: ["uiSpec", "penpotDesign"],
  slicePlan: ["uiSpec", "penpotDesign"],
  apiContract: ["uiSpec", "penpotDesign"],
  uiSpec: [],
  penpotDesign: [],
};

/** Which documents a change to `changed` makes Stale, given their current statuses. */
export function documentsMadeStale(
  changed: DocumentKind,
  statuses: Partial<Record<DocumentKind, DocumentStatus>>,
): DocumentKind[] {
  return DOWNSTREAM[changed].filter((kind) => {
    const status = statuses[kind];
    return status !== undefined && TRANSITIONS[status]?.upstreamChanged;
  });
}
