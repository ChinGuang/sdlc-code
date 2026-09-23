/**
 * The stored design documents, read back into what agents use. The Slice Plan,
 * API Contract and UI Spec are stored as JSON for this (designDocuments.ts);
 * the System Design is Markdown for humans and is used as it is.
 */
import type { ApprovedDocuments } from "../agents/coding/codingContext.js";
import type { Design } from "../agents/systemDesign/design.js";
import { UiSpecSchema } from "../agents/uiDesign/uiSpec.js";
import type { DocumentKind } from "../domain/documentLifecycle.js";
import type { DocumentStore } from "../persistence/documentStore.js";

export class MissingDocumentError extends Error {
  constructor(runId: string, kind: DocumentKind) {
    super(`Run ${runId} has no ${kind} document yet.`);
    this.name = "MissingDocumentError";
  }
}

/** The latest version of every text document the agents build from. */
export function loadApprovedDocuments(
  documents: DocumentStore,
  runId: string,
): ApprovedDocuments {
  const content = (kind: DocumentKind) =>
    documentContent(documents, runId, kind);
  return {
    systemDesign: content("systemDesign"),
    slicePlan: JSON.parse(content("slicePlan")) as Design["slicePlan"],
    apiContract: JSON.parse(content("apiContract")) as Design["apiContract"],
    uiSpec: UiSpecSchema.parse(JSON.parse(content("uiSpec"))),
  };
}

/** The latest version's content; throws when the Run has no such document. */
export function documentContent(
  documents: DocumentStore,
  runId: string,
  kind: DocumentKind,
): string {
  const document = documents.getLatest(runId, kind);
  if (!document) throw new MissingDocumentError(runId, kind);
  return document.content;
}

/**
 * The design as the System Design Agent revises it. The stored System Design
 * is its Markdown, diagrams included, so it goes back as the overview.
 */
export function storedDesign(
  documents: Pick<
    ApprovedDocuments,
    "systemDesign" | "slicePlan" | "apiContract"
  >,
): Design {
  return {
    systemDesign: { overview: documents.systemDesign, diagrams: [] },
    slicePlan: [...documents.slicePlan],
    apiContract: documents.apiContract,
  };
}
