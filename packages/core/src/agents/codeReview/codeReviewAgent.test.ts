import {
  BASELINE_RULES,
  REACT_NODE,
  type Rule,
} from "@sdlc-code/stack-profiles";
import type { ChatRequest, ChatResponse, ToolCall } from "@sdlc-code/clients";
import { describe, expect, it } from "vitest";
import { ChatAgentLoop } from "../../agentLoop/agentLoop.js";
import { goodDesign } from "../systemDesign/fixtures/goodDesign.js";
import { goodUiSpec } from "../uiDesign/fixtures/goodUiSpec.js";
import {
  LoopCodeReviewAgent,
  SUBMIT_FINDINGS,
  type CodeReviewAgent,
  type CodeReviewInput,
} from "./codeReviewAgent.js";
import type { Finding } from "./findings.js";

const design = goodDesign();

const DIFF = `diff --git a/server/todos.ts b/server/todos.ts
+++ b/server/todos.ts
@@ -0,0 +1,4 @@ export function todos()
+export function todos() {
+  return db.query("select * from todos where title = '" + title + "'");
+}
`;

function input(overrides: Partial<CodeReviewInput> = {}): CodeReviewInput {
  return {
    projectRequest: "Build a todo app",
    profile: REACT_NODE,
    documents: {
      systemDesign: "# System Design\n\nReact talks to a Node API.",
      slicePlan: design.slicePlan,
      apiContract: design.apiContract,
      uiSpec: goodUiSpec(),
    },
    standard: BASELINE_RULES,
    diff: DIFF,
    linterFindings: [],
    ...overrides,
  };
}

type Reply = { content: string | null; toolCalls: ToolCall[] };

let callId = 0;
const submit = (findings: unknown[]): Reply => ({
  content: null,
  toolCalls: [
    {
      id: `call-${++callId}`,
      name: SUBMIT_FINDINGS,
      arguments: JSON.stringify({ findings }),
    },
  ],
});
const answer = (content = "Reviewed the Todos Slice."): Reply => ({
  content,
  toolCalls: [],
});

function agentReplaying(replies: Reply[]) {
  const requests: ChatRequest[] = [];
  const queue = [...replies];
  // Tests depend on the interface; only this factory knows the class.
  const agent: CodeReviewAgent = new LoopCodeReviewAgent({
    createLoop: (tools) =>
      new ChatAgentLoop({
        client: {
          complete: async (request): Promise<ChatResponse> => {
            requests.push(structuredClone(request));
            const next = queue.shift() ?? { content: "done", toolCalls: [] };
            return {
              ...next,
              reasoning: null,
              finishReason: next.toolCalls.length > 0 ? "tool_calls" : "stop",
              usage: { promptTokens: 900, completionTokens: 120 },
              latencyMs: 2,
            };
          },
        },
        request: { model: "nvidia/Nemotron-3-Ultra-550b-a55b" },
        tools,
        maxIterations: 8,
      }),
  });
  return { agent, requests };
}

describe("LoopCodeReviewAgent", () => {
  it("reports what it submitted, with the severity of each Rule", async () => {
    const { agent } = agentReplaying([
      submit([
        {
          ruleId: "SEC-02",
          file: "server/todos.ts",
          line: 2,
          message: "The title goes into SQL unvalidated.",
          suggestion: "Validate the body with zod first.",
        },
        {
          ruleId: "CLEAN-01",
          file: "server/todos.ts",
          line: 1,
          message: "`todos` says nothing about what it returns.",
        },
      ]),
      answer(),
    ]);

    const { findings, loop } = await agent.review(input());

    expect(loop.stopReason).toBe("answered");
    expect(
      findings.map((finding) => [finding.ruleId, finding.severity]),
    ).toEqual([
      ["SEC-02", "blocking"],
      ["CLEAN-01", "minor"],
    ]);
    expect(findings[0]?.source).toBe("codeReview");
  });

  it("takes Findings a few calls at a time", async () => {
    const { agent } = agentReplaying([
      submit([{ ruleId: "SEC-02", file: "a.ts", line: 1, message: "one" }]),
      submit([{ ruleId: "CLEAN-01", file: "b.ts", line: 2, message: "two" }]),
      answer(),
    ]);

    const { findings } = await agent.review(input());

    expect(findings.map((finding) => finding.message)).toEqual(["one", "two"]);
  });

  it("finds nothing when the review is clean", async () => {
    const { agent } = agentReplaying([answer("Nothing to report.")]);

    const { findings, loop } = await agent.review(input());

    expect(findings).toEqual([]);
    expect(loop.answer).toBe("Nothing to report.");
  });

  // An invented ID would otherwise carry an invented severity.
  it("drops a Finding citing a Rule the Review Standard does not have", async () => {
    const { agent } = agentReplaying([
      submit([
        { ruleId: "VIBES-01", file: "a.ts", line: 1, message: "feels wrong" },
        { ruleId: "SEC-02", file: "a.ts", line: 2, message: "unvalidated" },
      ]),
      answer(),
    ]);

    const { findings, unknownRuleIds } = await agent.review(input());

    expect(findings.map((finding) => finding.ruleId)).toEqual(["SEC-02"]);
    expect(unknownRuleIds).toEqual(["VIBES-01"]);
  });

  it("is told the Rules it may cite, the documents and the diff", async () => {
    const { agent, requests } = agentReplaying([answer()]);

    await agent.review(input());

    const [first] = requests;
    const system = String(first?.messages[0]?.content);
    const user = String(first?.messages[1]?.content);
    expect(system).toContain("SEC-02 (blocking):");
    expect(system).toContain("Every Finding cites one Rule ID");
    expect(user).toContain("React talks to a Node API.");
    expect(user).toContain("API Contract (OpenAPI):");
    expect(user).toContain("UI Spec:");
    expect(user).toContain("select * from todos");
    expect(user).toContain("The linters found nothing.");
  });

  it("is told what the linters already found, so it does not repeat them", async () => {
    const linterFindings: Finding[] = [
      {
        ruleId: "LINT-01",
        file: "src/App.tsx",
        line: 7,
        message: "'total' is defined but never used. (no-unused-vars)",
        severity: "blocking",
        source: "linter",
      },
    ];
    const { agent, requests } = agentReplaying([answer()]);

    await agent.review(input({ linterFindings }));

    const user = String(requests[0]?.messages[1]?.content);
    expect(user).toContain("do not repeat these");
    expect(user).toContain("LINT-01 src/App.tsx:7");
  });

  it("uses the Review Standard it is given, not the profile's own", async () => {
    const standard: Rule[] = [
      { id: "OURS-01", description: "Our own rule.", severity: "blocking" },
    ];
    const { agent, requests } = agentReplaying([
      submit([{ ruleId: "OURS-01", file: "a.ts", line: 1, message: "broken" }]),
      answer(),
    ]);

    const { findings } = await agent.review(input({ standard }));

    expect(findings[0]?.severity).toBe("blocking");
    expect(String(requests[0]?.messages[0]?.content)).toContain(
      "OURS-01 (blocking): Our own rule.",
    );
  });
});
