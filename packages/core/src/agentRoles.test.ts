import { describe, expect, it } from "vitest";
import { AGENT_ROLES, isAgentRole, documentOwner } from "./agentRoles.js";

describe("AGENT_ROLES", () => {
  it("lists the agents from CONTEXT.md", () => {
    expect(AGENT_ROLES).toEqual([
      "orchestrator",
      "systemDesign",
      "uiDesign",
      "backendCoding",
      "frontendCoding",
      "testing",
      "codeReview",
    ]);
  });

  it("recognises valid role names only", () => {
    expect(isAgentRole("testing")).toBe(true);
    expect(isAgentRole("subagent")).toBe(false);
  });
});

describe("documentOwner", () => {
  it("routes design documents to their owning agent (Verdict comments)", () => {
    expect(documentOwner("systemDesign")).toBe("systemDesign");
    expect(documentOwner("slicePlan")).toBe("systemDesign");
    expect(documentOwner("apiContract")).toBe("systemDesign");
    expect(documentOwner("uiSpec")).toBe("uiDesign");
    expect(documentOwner("penpotDesign")).toBe("uiDesign");
  });
});
