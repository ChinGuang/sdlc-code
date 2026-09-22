import { describe, expect, it } from "vitest";
import type { ApprovedDocuments } from "../agents/coding/codingContext.js";
import { goodDesign } from "../agents/systemDesign/fixtures/goodDesign.js";
import { goodUiSpec } from "../agents/uiDesign/fixtures/goodUiSpec.js";
import { issueReport } from "./fixtures/issueReport.js";
import {
  resolveByDocuments,
  RuleOwnerResolver,
  type OwnerContext,
  type OwnerDecision,
  type OwnerJudge,
  type OwnerResolver,
} from "./ownerResolution.js";

const design = goodDesign();

/** The todo app's documents, with a UI Spec screen and a Slice that rely on operations the API Contract lacks. */
function context(): OwnerContext {
  const uiSpec = goodUiSpec();
  uiSpec.screens[1]!.endpoints.push("DELETE /todos/{id}");
  const documents: ApprovedDocuments = {
    systemDesign: "# System Design",
    slicePlan: [
      ...design.slicePlan,
      {
        title: "Tags",
        goal: "Tag todos",
        isWalkingSkeleton: false,
        endpoints: ["GET /tags"],
      },
    ],
    apiContract: design.apiContract,
    uiSpec,
  };
  return { documents, slice: design.slicePlan[1]! };
}

// Diagram 7, in its order: each row is one Issue Report and its Owner.
const TABLE: Array<{
  name: string;
  report: Parameters<typeof issueReport>[0];
  expected: Pick<OwnerDecision, "owner" | "rule"> | null;
}> = [
  {
    name: "a backend test fails on an operation the Contract defines",
    report: {},
    expected: { owner: "backendCoding", rule: "codeDeviates" },
  },
  {
    name: "a frontend test fails, no operation named",
    report: {
      failingTest: "TodoList > shows the empty state",
      file: "src/TodoList.test.tsx",
      endpoint: null,
      suspectedOwner: "frontendCoding",
    },
    expected: { owner: "frontendCoding", rule: "codeDeviates" },
  },
  {
    name: "the API crashes on boot",
    report: {
      step: "boot",
      failingTest: null,
      file: "server/main.ts",
      endpoint: null,
    },
    expected: { owner: "backendCoding", rule: "codeDeviates" },
  },
  {
    name: "a screen calls an operation missing from the Contract",
    report: {
      failingTest: "DELETE /todos/{id} > removes a todo",
      endpoint: "DELETE /todos/{id}",
      suspectedOwner: "frontendCoding",
    },
    expected: { owner: "uiDesign", rule: "documentsContradict" },
  },
  {
    name: "the Slice Plan lists an operation missing from the Contract",
    report: { endpoint: "GET /tags", suspectedOwner: "backendCoding" },
    expected: { owner: "systemDesign", rule: "documentsContradict" },
  },
  {
    name: "the code tests an operation no document defines",
    report: { endpoint: "PATCH /todos/{id}/archive" },
    expected: { owner: "backendCoding", rule: "codeDeviates" },
  },
  {
    name: "an install failure: package.json is shared",
    report: {
      step: "install",
      failingTest: null,
      file: null,
      endpoint: null,
      suspectedOwner: null,
    },
    expected: null,
  },
  {
    name: "the sandbox never finished",
    report: {
      step: "sandbox",
      failingTest: null,
      file: null,
      endpoint: null,
      suspectedOwner: null,
    },
    expected: null,
  },
];

describe("resolveByDocuments (diagram 7 in order)", () => {
  it.each(TABLE)("$name", ({ report, expected }) => {
    const decision = resolveByDocuments(issueReport(report), context());

    if (expected === null) expect(decision).toBeNull();
    else expect(decision).toMatchObject(expected);
    expect(decision?.reason ?? "").not.toMatch(/undefined|null/);
  });
});

describe("RuleOwnerResolver", () => {
  function judging(decision: OwnerDecision | null) {
    const asked: string[] = [];
    const judge: OwnerJudge = {
      judge: async (report) => {
        asked.push(report.step);
        return decision;
      },
    };
    return { judge, asked };
  }

  it("never asks the judge what the documents settle", async () => {
    const { judge, asked } = judging(null);
    // Tests depend on the interface; only this factory knows the class.
    const resolver: OwnerResolver = new RuleOwnerResolver({ judge });

    const decision = await resolver.resolve(issueReport(), context());

    expect(decision.owner).toBe("backendCoding");
    expect(asked).toEqual([]);
  });

  it("asks the judge what they do not", async () => {
    const { judge, asked } = judging({
      owner: "systemDesign",
      rule: "requirementMissing",
      reason: "No document says which Node version to install.",
    });
    const resolver: OwnerResolver = new RuleOwnerResolver({ judge });

    const decision = await resolver.resolve(
      issueReport({ step: "install", suspectedOwner: null, endpoint: null }),
      context(),
    );

    expect(asked).toEqual(["install"]);
    expect(decision).toMatchObject({
      owner: "systemDesign",
      rule: "requirementMissing",
    });
  });

  it("leaves it to a person when the judge cannot decide either", async () => {
    const resolver: OwnerResolver = new RuleOwnerResolver({
      judge: judging(null).judge,
    });

    const decision = await resolver.resolve(
      issueReport({
        step: "sandbox",
        error: "The sandbox run timed out.",
        suspectedOwner: null,
        endpoint: null,
      }),
      context(),
    );

    expect(decision).toEqual({
      owner: "human",
      rule: "undecidable",
      reason:
        "Neither the evidence nor the Approved Documents say who should fix: The sandbox run timed out.",
    });
  });

  it("leaves it to a person without a judge", async () => {
    const resolver: OwnerResolver = new RuleOwnerResolver();

    const decision = await resolver.resolve(
      issueReport({ suspectedOwner: null, endpoint: null }),
      context(),
    );

    expect(decision.owner).toBe("human");
  });
});
