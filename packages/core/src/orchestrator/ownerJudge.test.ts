import {
  ChatApiError,
  type ChatRequest,
  type ChatResponse,
} from "@sdlc-code/clients";
import { describe, expect, it } from "vitest";
import { goodDesign } from "../agents/systemDesign/fixtures/goodDesign.js";
import { goodUiSpec } from "../agents/uiDesign/fixtures/goodUiSpec.js";
import { issueReport } from "./fixtures/issueReport.js";
import { DECIDE_OWNER, ModelOwnerJudge } from "./ownerJudge.js";
import type { OwnerContext, OwnerJudge } from "./ownerResolution.js";

const design = goodDesign();
const context: OwnerContext = {
  documents: {
    systemDesign: "# System Design\n\nReact talks to a Node API.",
    slicePlan: design.slicePlan,
    apiContract: design.apiContract,
    uiSpec: goodUiSpec(),
  },
  slice: design.slicePlan[1]!,
};
const unclear = issueReport({
  step: "install",
  failingTest: null,
  file: null,
  endpoint: null,
  suspectedOwner: null,
  error: "npm error code ETARGET",
});

/** A judge whose model answers with `reply` and records the request. */
function judgeAnswering(
  reply: Partial<ChatResponse> | Error,
  budget?: { left: number },
) {
  const requests: ChatRequest[] = [];
  let spent = 0;
  // Tests depend on the interface; only this factory knows the class.
  const judge: OwnerJudge = new ModelOwnerJudge({
    client: {
      complete: async (request) => {
        requests.push(request);
        if (reply instanceof Error) throw reply;
        return {
          content: null,
          reasoning: null,
          toolCalls: [],
          finishReason: "tool_calls",
          usage: { promptTokens: 900, completionTokens: 60 },
          latencyMs: 1,
          ...reply,
        };
      },
    },
    request: { model: "nvidia/Nemotron-3-Ultra-550b-a55b" },
    budget: budget && {
      remaining: () => budget.left - spent,
      spend: (tokens) => void (spent += tokens),
    },
  });
  return { judge, requests, spent: () => spent };
}

const decide = (args: unknown) => ({
  toolCalls: [
    { id: "c1", name: DECIDE_OWNER, arguments: JSON.stringify(args) },
  ],
});

describe("ModelOwnerJudge", () => {
  it("forces one decide_owner call with the report and the documents", async () => {
    const { judge, requests } = judgeAnswering(
      decide({
        owner: "systemDesign",
        rule: "requirementMissing",
        reason:
          "The zod version in package.json does not exist; no document pins it.",
      }),
    );

    const decision = await judge.judge(unclear, context);

    expect(decision).toEqual({
      owner: "systemDesign",
      rule: "requirementMissing",
      reason:
        "The zod version in package.json does not exist; no document pins it.",
    });
    expect(requests[0]!.toolChoice).toEqual({ name: DECIDE_OWNER });
    const user = requests[0]!.messages[1]!.content as string;
    expect(user).toContain("error: npm error code ETARGET");
    expect(user).toContain("API Contract (OpenAPI):\nopenapi: 3.1.0");
    expect(user).toContain("name: Todo list");
  });

  it.each([
    [
      "an owner the rule does not allow",
      { owner: "backendCoding", rule: "requirementMissing", reason: "x" },
    ],
    [
      "an unknown owner",
      { owner: "testing", rule: "codeDeviates", reason: "x" },
    ],
    [
      "no reason",
      { owner: "systemDesign", rule: "requirementMissing", reason: " " },
    ],
  ])("treats %s as undecided", async (_name, args) => {
    const { judge } = judgeAnswering(decide(args));

    expect(await judge.judge(unclear, context)).toBeNull();
  });

  it("treats an answer without the tool call, or cut off, as undecided", async () => {
    expect(
      await judgeAnswering({ content: "systemDesign" }).judge.judge(
        unclear,
        context,
      ),
    ).toBeNull();
    expect(
      await judgeAnswering({
        ...decide({
          owner: "systemDesign",
          rule: "requirementMissing",
          reason: "x",
        }),
        finishReason: "length",
      }).judge.judge(unclear, context),
    ).toBeNull();
  });

  it("leaves it to a person when Token Factory fails", async () => {
    const { judge } = judgeAnswering(new ChatApiError(503, null, "busy"));

    expect(await judge.judge(unclear, context)).toBeNull();
  });

  it("charges the Token Budget, and does not call the model once it is spent", async () => {
    const paid = judgeAnswering(
      decide({ owner: "human", rule: "undecidable", reason: "Unclear." }),
      { left: 5000 },
    );
    await paid.judge.judge(unclear, context);
    expect(paid.spent()).toBe(960);

    const broke = judgeAnswering(decide({}), { left: 0 });
    expect(await broke.judge.judge(unclear, context)).toBeNull();
    expect(broke.requests).toEqual([]);
  });
});
