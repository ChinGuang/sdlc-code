/**
 * A Run's Approved Documents, stored as the Design Phase stores them, for tests
 * that need documents to read rather than a design to make.
 */
import { designDocuments } from "../../agents/systemDesign/designDocuments.js";
import { goodDesign } from "../../agents/systemDesign/fixtures/goodDesign.js";
import { goodUiSpec } from "../../agents/uiDesign/fixtures/goodUiSpec.js";
import type { DocumentKind } from "../../domain/documentLifecycle.js";
import type { DocumentStore } from "../../persistence/documentStore.js";

/** Writes the four text documents of a design, each approved. */
export function storedDesignDocuments(
  documents: DocumentStore,
  runId: string,
): void {
  const { systemDesign, slicePlan, apiContract } =
    designDocuments(goodDesign());
  const contents: Array<[DocumentKind, string]> = [
    ["systemDesign", systemDesign],
    ["slicePlan", slicePlan],
    ["apiContract", apiContract],
    ["uiSpec", `${JSON.stringify(goodUiSpec(), null, 2)}\n`],
  ];
  for (const [kind, content] of contents) {
    documents.createDocument({ runId, kind, content });
    documents.applyEvent(runId, kind, "ownerFinished");
    documents.applyEvent(runId, kind, "approved");
  }
}
