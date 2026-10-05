// SPDX-License-Identifier: MPL-2.0
/**
 * The review seam over a real database: which Rules a Run reviews against, what
 * the linters contribute, what the agent is told, and what is said out loud
 * rather than passed off as a clean review.
 */
import {
  BASELINE_RULES,
  parseLintScriptOutput,
  REACT_NODE,
  type LintProblem,
  type TemplateFile,
} from "@sdlc-code/stack-profiles";
import { describe, expect, it } from "vitest";
import type {
  CodeReviewAgent,
  CodeReviewInput,
} from "../agents/codeReview/codeReviewAgent.js";
import type { ReportedFinding } from "../agents/codeReview/findings.js";
import { openDatabase } from "../persistence/database.js";
import { SqliteDocumentStore } from "../persistence/documentStore.js";
import { SqliteRunStore } from "../persistence/runStore.js";
import { lintOutput } from "../testRuns/fixtures/fakeSandbox.js";
import type { LintRunner, LintRunOutcome } from "../testRuns/lintRunner.js";
import { storedDesignDocuments } from "./fixtures/storedDocuments.js";
import { AgentRunReview, type RunReview } from "./runReview.js";

const FILES: TemplateFile[] = [
  { path: "src/App.tsx", contents: "export const App = () => null;\n" },
];

const EVIDENCE = {
  operationId: "op",
  exitCode: 0,
  timedOut: false,
  durationSeconds: 1,
  cost: 0,
  log: "",
  changedFiles: [],
  removedFiles: [],
  withheldFiles: [],
};

/**
 * A Lint Run built from the fixture the sandbox tests use and read back through
 * the real parser, so a warning counts here exactly as the script reports one.
 */
function linted(
  problems: Array<Partial<LintProblem> & { tool: "eslint" | "tsc" }>,
): LintRunOutcome {
  const parsed = parseLintScriptOutput(lintOutput(problems));
  if ("problem" in parsed) throw new Error(parsed.problem);
  return { status: "linted", result: parsed.result, evidence: EVIDENCE };
}

function setup(
  options: {
    lint?: LintRunOutcome;
    userStandards?: string | null;
    agentFindings?: ReportedFinding[];
    /** What the agent reported that the diff did not support (T25a). */
    notRecorded?: string[];
    /** What the Workspace's diff is; a short one unless a test cuts it. */
    diff?: string;
    stopReason?: "answered" | "tokenBudget";
  } = {},
) {
  const db = openDatabase(":memory:");
  const store = { db };
  const runs = new SqliteRunStore(store);
  const documents = new SqliteDocumentStore(store);
  const run = runs.createRun({
    projectRequest: "Build a todo app",
    mode: "auto",
    targetRepo: {
      owner: "local",
      name: "app",
      baseBranch: "main",
      runBranch: "sdlc/run",
    },
    stackProfile: REACT_NODE.id,
    tokenBudget: 1_000_000,
  });
  storedDesignDocuments(documents, run.id);

  const workspaces = {
    lastSliceCommit: async () => "commit-1",
    readFiles: async () => FILES,
    runDiff: async () =>
      options.diff ?? "diff --git a/src/App.tsx b/src/App.tsx\n+const d = 1;\n",
  };

  const linters: LintRunner = {
    runLinters: async () => options.lint ?? linted([]),
  };
  const reviewCalls: CodeReviewInput[] = [];
  const agent: CodeReviewAgent = {
    review: async (input) => {
      reviewCalls.push(input);
      return {
        findings: (options.agentFindings ?? []).map((finding) => ({
          ...finding,
          severity: "major" as const,
          source: "codeReview" as const,
        })),
        unknownRuleIds: [],
        notRecorded: options.notRecorded ?? [],
        loop: {
          stopReason: options.stopReason ?? "answered",
          answer: "Reviewed.",
          workingMemory: "-",
          iterations: 1,
          toolCalls: 0,
          failedToolCalls: 0,
          usage: { promptTokens: 1, completionTokens: 1 },
          error: null,
        },
      };
    },
  };
  // Tests depend on the interface; only this factory knows the class.
  const review: RunReview = new AgentRunReview({
    documents,
    workspaces,
    profile: () => REACT_NODE,
    linters,
    agent,
    userStandards: async () => options.userStandards ?? null,
  });
  return { review, run, reviewCalls };
}

describe("AgentRunReview: the Rules it reviews against", () => {
  it("is the Stack Profile's baseline when the user has no standards", async () => {
    const { review, run, reviewCalls } = setup();

    const result = await review.reviewRun(run);

    expect(result.problems).toEqual([]);
    expect(reviewCalls[0]?.standard).toEqual([...BASELINE_RULES]);
  });

  it("layers the user's AGENTS.md on top, and reports what it could not read", async () => {
    const { review, run, reviewCalls } = setup({
      userStandards: [
        "## Review Standard",
        "- SEC-09 (blocking): No SQL built by hand.",
        "- LINT-02 (blocking): A warning is a bug.",
        "- Be nice.",
      ].join("\n"),
    });

    const result = await review.reviewRun(run);

    const standard = reviewCalls[0]!.standard;
    expect(standard.find((rule) => rule.id === "LINT-02")?.severity).toBe(
      "blocking",
    );
    expect(standard.at(-1)).toEqual({
      id: "SEC-09",
      severity: "blocking",
      description: "No SQL built by hand.",
    });
    expect(result.problems).toEqual([expect.stringContaining('"- Be nice."')]);
  });
});

describe("AgentRunReview: what the linters contribute", () => {
  it("turns what they found into Findings of this Run's Rules", async () => {
    const { review, run } = setup({
      lint: linted([
        {
          tool: "eslint",
          severity: "error",
          file: "src/App.tsx",
          line: 2,
          rule: "no-unused-vars",
          message: "'d' is defined but never used.",
        },
      ]),
    });

    const { findings } = await review.reviewRun(run);

    expect(findings).toEqual([
      {
        ruleId: "LINT-01",
        file: "src/App.tsx",
        line: 2,
        message: "'d' is defined but never used. (no-unused-vars)",
        severity: "blocking",
        source: "linter",
      },
    ]);
  });

  it("gives the agent what they found, and the diff, so it adds to them", async () => {
    const { review, run, reviewCalls } = setup({
      lint: linted([{ tool: "eslint", severity: "warning" }]),
    });

    await review.reviewRun(run);

    expect(
      reviewCalls[0]?.linterFindings.map((finding) => finding.ruleId),
    ).toEqual(["LINT-02"]);
    expect(reviewCalls[0]?.diff).toContain("+const d = 1;");
    expect(reviewCalls[0]?.documents.systemDesign).toContain("# System Design");
  });

  // Our own tooling failing is not the application's fault.
  it("says a broken Lint Run out loud and blocks nothing", async () => {
    const { review, run } = setup({
      lint: {
        status: "broken",
        problem: "The lint script printed no SDLC_LINT line.",
        evidence: EVIDENCE,
      },
    });

    const { findings, problems } = await review.reviewRun(run);

    expect(findings).toEqual([]);
    expect(problems).toEqual([
      expect.stringContaining("The linters did not run"),
    ]);
  });

  // T25a: what the agent claimed and the diff did not support is not a
  // Finding, but a person is told it was left out.
  it("passes on the Findings the Code Review Agent made that the diff did not support", async () => {
    const claim =
      "The Code Review Agent's SEC-02 Finding at server/todos.ts:15 was not recorded: the diff does not show that code at server/todos.ts:15.";
    const { review, run } = setup({ notRecorded: [claim] });

    const { findings, problems } = await review.reviewRun(run);

    expect(findings).toEqual([]);
    expect(problems).toEqual([claim]);
  });

  it("tells a person when the diff was too big to read whole", async () => {
    const { review, run } = setup({
      diff: "diff --git a/a.ts b/a.ts\n+x\n…(the diff is 412345 bytes; cut here)\n",
    });

    const { problems } = await review.reviewRun(run);

    expect(problems).toEqual([
      "The diff of this Run is 412345 bytes, more than a review reads: the Code Review Agent read the first part only.",
    ]);
  });

  it("says so when a tool failed without reporting anything", async () => {
    const broken = linted([]);
    if (broken.status !== "linted") throw new Error("fixture");
    broken.result.checks = [
      {
        name: "eslint",
        ok: false,
        durationMs: 1,
        output: "Cannot find eslint.config.js",
      },
      { name: "tsc", ok: true, durationMs: 1, output: "" },
    ];
    const { review, run } = setup({ lint: broken });

    const { problems } = await review.reviewRun(run);

    expect(problems).toEqual([
      expect.stringContaining("eslint failed without reporting anything"),
    ]);
  });
});

describe("AgentRunReview: what it says about itself", () => {
  it("passes on the agent's Findings beside the linters'", async () => {
    const { review, run } = setup({
      lint: linted([{ tool: "eslint", severity: "warning" }]),
      agentFindings: [
        {
          ruleId: "TEST-02",
          file: "src/App.tsx",
          line: 1,
          message: "The screen has no test.",
        },
      ],
    });

    const { findings } = await review.reviewRun(run);

    expect(findings.map((finding) => [finding.ruleId, finding.source])).toEqual(
      [
        ["LINT-02", "linter"],
        ["TEST-02", "codeReview"],
      ],
    );
  });

  // A review that stopped early read part of the diff, so its silence is not
  // evidence of anything; the Orchestrator has to be able to see that.
  it("reports how the agent's Step ended", async () => {
    const finished = setup();
    expect((await finished.review.reviewRun(finished.run)).stopReason).toBe(
      "answered",
    );

    const stopped = setup({ stopReason: "tokenBudget" });

    expect((await stopped.review.reviewRun(stopped.run)).stopReason).toBe(
      "tokenBudget",
    );
  });
});
