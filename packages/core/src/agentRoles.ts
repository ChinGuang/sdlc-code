/** The agents that take part in a Run (see CONTEXT.md). */
export const AGENT_ROLES = [
  "orchestrator",
  "systemDesign",
  "uiDesign",
  "backendCoding",
  "frontendCoding",
  "testing",
  "codeReview",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value);
}

/**
 * Documents reviewed at the Design Gate. The Penpot design gets a Verdict too,
 * but only the text documents become Approved Documents (see CONTEXT.md).
 */
export type DocumentKind =
  "systemDesign" | "slicePlan" | "apiContract" | "uiSpec" | "penpotDesign";

const DOCUMENT_OWNERS: Record<DocumentKind, AgentRole> = {
  systemDesign: "systemDesign",
  slicePlan: "systemDesign",
  apiContract: "systemDesign",
  uiSpec: "uiDesign",
  penpotDesign: "uiDesign",
};

/** The agent that receives Verdict comments for a document. */
export function documentOwner(kind: DocumentKind): AgentRole {
  return DOCUMENT_OWNERS[kind];
}
