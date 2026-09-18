import { describe, expect, it } from "vitest";
import { AGENT_ROLES, isAgentRole, ownsDocument } from "./agentRoles.js";

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

describe("ownsDocument", () => {
  it("routes design documents to their owning agent (Verdict comments)", () => {
    expect(ownsDocument("systemDesign")).toBe("systemDesign");
    expect(ownsDocument("slicePlan")).toBe("systemDesign");
    expect(ownsDocument("apiContract")).toBe("systemDesign");
    expect(ownsDocument("uiSpec")).toBe("uiDesign");
    expect(ownsDocument("penpotDesign")).toBe("uiDesign");
  });
});
