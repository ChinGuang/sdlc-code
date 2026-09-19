/**
 * The stored form of a design: one document per kind (T07 DocumentStore).
 * The System Design is Markdown for humans at the Design Gate; the Slice Plan
 * and API Contract are JSON because later agents read them.
 */
import type { Design } from "./design.js";

export type DesignDocuments = {
  systemDesign: string;
  slicePlan: string;
  apiContract: string;
};

export function designDocuments(design: Design): DesignDocuments {
  const { overview, diagrams } = design.systemDesign;
  const body = overview.trim();
  const systemDesign = [
    // The model often writes its own title; do not add a second one.
    ...(body.startsWith("# ") ? [] : ["# System Design"]),
    body,
    ...diagrams.map(
      (diagram) =>
        `## ${diagram.title}\n\n\`\`\`mermaid\n${diagram.mermaid.trim()}\n\`\`\``,
    ),
  ].join("\n\n");
  return {
    systemDesign: `${systemDesign}\n`,
    slicePlan: `${JSON.stringify(design.slicePlan, null, 2)}\n`,
    apiContract: `${JSON.stringify(design.apiContract, null, 2)}\n`,
  };
}
