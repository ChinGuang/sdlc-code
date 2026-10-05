// SPDX-License-Identifier: MPL-2.0
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
          quote: "select * from todos where title",
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
      submit([
        {
          ruleId: "CLEAN-01",
          file: "server/todos.ts",
          line: 1,
          message: "one",
        },
      ]),
      submit([
        {
          ruleId: "CLEAN-01",
          file: "server/todos.ts",
          line: 3,
          message: "two",
        },
      ]),
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
        {
          ruleId: "VIBES-01",
          file: "server/todos.ts",
          line: 1,
          message: "feels wrong",
        },
        {
          ruleId: "SEC-02",
          file: "server/todos.ts",
          line: 2,
          message: "unvalidated",
          quote: "return db.query",
        },
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
      submit([
        {
          ruleId: "OURS-01",
          file: "server/todos.ts",
          line: 1,
          message: "broken",
          quote: "export function todos",
        },
      ]),
      answer(),
    ]);

    const { findings } = await agent.review(input({ standard }));

    expect(findings[0]?.severity).toBe("blocking");
    expect(String(requests[0]?.messages[0]?.content)).toContain(
      "OURS-01 (blocking): Our own rule.",
    );
  });

  it("takes more than five Findings in one call", async () => {
    // A review of a whole Run finds more than five things; refusing the call
    // wasted the turn that wrote it (found in T25).
    const many = Array.from({ length: 12 }, (_, index) => ({
      ruleId: "CLEAN-01",
      file: "server/todos.ts",
      line: 1,
      message: `finding ${index}`,
    }));
    const { agent } = agentReplaying([submit(many), answer()]);

    const { findings, loop } = await agent.review(input());

    expect(findings).toHaveLength(12);
    expect(loop.failedToolCalls).toBe(0);
  });

  it("stops recording once enough Findings are in, and says so", async () => {
    const batch = (from: number) =>
      Array.from({ length: 25 }, (_, index) => ({
        ruleId: "CLEAN-01",
        file: "server/todos.ts",
        line: 1,
        message: `finding ${from + index}`,
      }));
    const { agent, requests } = agentReplaying([
      submit(batch(0)),
      submit(batch(25)),
      answer(),
    ]);

    const { findings, notRecorded } = await agent.review(input());

    expect(findings).toHaveLength(40);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
      "enough Findings are recorded",
    );
    // A person is told too, once for the same Finding sent 10 times.
    expect(notRecorded).toEqual([
      expect.stringContaining("was not recorded: enough Findings are recorded"),
    ]);
  });
});

// Found in T25: blocking Findings about code that was fine ("component is
// incomplete, missing imports") sent a passing Slice back, and the linters had
// already said it compiled.
describe("LoopCodeReviewAgent: the diff supports what it reports (T25a)", () => {
  const toolResult = (requests: ChatRequest[]) =>
    String(
      requests.at(-1)?.messages.findLast((message) => message.role === "tool")
        ?.content,
    );

  it("does not record a Finding about a file the diff does not show, and says so", async () => {
    const { agent, requests } = agentReplaying([
      submit([
        { ruleId: "CLEAN-01", file: "src/Nope.tsx", line: 1, message: "bad" },
      ]),
      answer(),
    ]);

    const { findings, notRecorded } = await agent.review(input());

    expect(findings).toEqual([]);
    expect(notRecorded).toEqual([
      "The Code Review Agent's CLEAN-01 Finding at src/Nope.tsx:1 was not recorded: the diff does not show src/Nope.tsx (use the path as the diff writes it).",
    ]);
    expect(toolResult(requests)).toContain("0 Findings recorded");
    expect(toolResult(requests)).toContain("Not recorded:");
  });

  // The same file and Rule at another line is another Finding: putting one
  // right does not excuse the other.
  it("tells a person of a refusal even when the same Rule is recorded elsewhere in the file", async () => {
    const { agent } = agentReplaying([
      submit([
        { ruleId: "CLEAN-01", file: "server/todos.ts", line: 1, message: "a" },
        { ruleId: "CLEAN-01", file: "server/todos.ts", line: 99, message: "b" },
      ]),
      answer(),
    ]);

    const { findings, notRecorded } = await agent.review(input());

    expect(findings).toHaveLength(1);
    expect(notRecorded).toHaveLength(1);
    expect(notRecorded[0]).toContain("line 99");
  });

  it("tells a person of the same refusal once", async () => {
    const bad = { ruleId: "CLEAN-01", file: "nope.ts", line: 1, message: "x" };
    const { agent } = agentReplaying([submit([bad]), submit([bad]), answer()]);

    const { notRecorded } = await agent.review(input());

    expect(notRecorded).toHaveLength(1);
  });

  it("does not record a Finding about a line the diff does not show", async () => {
    const { agent } = agentReplaying([
      submit([
        { ruleId: "CLEAN-01", file: "server/todos.ts", line: 99, message: "x" },
      ]),
      answer(),
    ]);

    const { findings, notRecorded } = await agent.review(input());

    expect(findings).toEqual([]);
    expect(notRecorded[0]).toContain(
      "the diff does not show line 99 of server/todos.ts",
    );
  });

  it("holds a blocking Finding to a quote, and records it once it has one", async () => {
    const blocking = {
      ruleId: "SEC-02",
      file: "server/todos.ts",
      line: 2,
      message: "The title goes into SQL unvalidated.",
    };
    const { agent, requests } = agentReplaying([
      submit([blocking]),
      submit([{ ...blocking, quote: "return db.query(" }]),
      answer(),
    ]);

    const { findings, notRecorded } = await agent.review(input());

    expect(findings.map((finding) => finding.ruleId)).toEqual(["SEC-02"]);
    // Put right inside the Step, so a person is not told of it.
    expect(notRecorded).toEqual([]);
    expect(JSON.stringify(requests[1]?.messages.at(-1))).toContain(
      "must quote the line of code it is about",
    );
  });

  it("does not record a blocking Finding whose quote is not in the diff there", async () => {
    const { agent } = agentReplaying([
      submit([
        {
          ruleId: "SEC-02",
          file: "server/todos.ts",
          line: 2,
          message: "parseResult is not used",
          quote: "const parseResult = schema.parse(request.body);",
        },
      ]),
      answer(),
    ]);

    const { findings, notRecorded } = await agent.review(input());

    expect(findings).toEqual([]);
    expect(notRecorded[0]).toContain(
      "the diff does not show that code at server/todos.ts:2",
    );
  });

  it("finds a quote a line or two off and under other spacing, as models cite", async () => {
    const { agent } = agentReplaying([
      submit([
        {
          ruleId: "SEC-02",
          file: "server/todos.ts",
          line: 3,
          message: "SQL built from input.",
          quote: 'return   db.query("select * from todos',
        },
      ]),
      answer(),
    ]);

    const { findings } = await agent.review(input());

    expect(findings).toHaveLength(1);
  });

  it("leaves the LINT Rules to the linters", async () => {
    const { agent } = agentReplaying([
      submit([
        {
          ruleId: "LINT-03",
          file: "server/todos.ts",
          line: 1,
          message: "TypeScript errors: incomplete component",
          quote: "export function todos",
        },
      ]),
      answer(),
    ]);

    const { findings, notRecorded } = await agent.review(input());

    expect(findings).toEqual([]);
    expect(notRecorded[0]).toContain("the linters report the LINT Rules");
  });

  // What would send work back is never what the cap leaves out.
  it("records a blocking Finding after the cap has been reached", async () => {
    const minors = Array.from({ length: 25 }, (_, index) => ({
      ruleId: "CLEAN-01",
      file: "server/todos.ts",
      line: 1,
      message: `finding ${index}`,
    }));
    const blocking = {
      ruleId: "SEC-02",
      file: "server/todos.ts",
      line: 2,
      message: "SQL built from input.",
      quote: "return db.query(",
    };
    const { agent } = agentReplaying([
      submit(minors),
      submit(minors),
      submit([blocking]),
      answer(),
    ]);

    const { findings, notRecorded } = await agent.review(input());

    expect(findings.at(-1)?.ruleId).toBe("SEC-02");
    expect(findings).toHaveLength(41);
    // The minors beyond forty are told once, not once each.
    expect(notRecorded).toEqual([
      expect.stringContaining("enough Findings are recorded"),
    ]);
  });

  it("tells a person of a few refusals, and counts the rest", async () => {
    const invented = Array.from({ length: 12 }, (_, index) => ({
      ruleId: "CLEAN-01",
      file: `src/Invented${index}.tsx`,
      line: 1,
      message: "bad",
    }));
    const { agent } = agentReplaying([submit(invented), answer()]);

    const { notRecorded } = await agent.review(input());

    expect(notRecorded).toHaveLength(9);
    expect(notRecorded.at(-1)).toBe(
      "4 more of the Code Review Agent's Findings were not recorded.",
    );
  });

  it("does not offer the LINT Rules, which are the linters' to report", async () => {
    const { agent, requests } = agentReplaying([answer()]);

    await agent.review(input());

    const system = String(requests[0]?.messages[0]?.content);
    expect(system).not.toContain("LINT-01 (");
    expect(system).not.toContain("LINT-03 (");
    expect(system).toContain("SEC-02 (blocking):");
    expect(system).toContain("cite the file that should have it, at line 0");
  });

  it("does not ask for a quote of a Finding that cannot block", async () => {
    const { agent } = agentReplaying([
      submit([
        { ruleId: "CLEAN-01", file: "server/todos.ts", line: 2, message: "x" },
      ]),
      answer(),
    ]);

    const { findings } = await agent.review(input());

    expect(findings).toHaveLength(1);
  });

  it("tells the agent a blocking Finding needs a quote, and not to report what a compiler found", async () => {
    const { agent, requests } = agentReplaying([answer()]);

    await agent.review(input());

    const system = String(requests[0]?.messages[0]?.content);
    expect(system).toContain("quotes the line of code it is about");
    expect(system).toContain("Never report a compile error");
  });
});
