/**
 * The review seam over a real database: which Rules a Run reviews against, what
 * the linters contribute, and what is said out loud rather than passed quietly.
 */
import {
  BASELINE_RULES,
  REACT_NODE,
  type LintProblem,
  type TemplateFile,
} from "@sdlc-code/stack-profiles";
import { describe, expect, it } from "vitest";
import type { CodeReviewAgent } from "../agents/codeReview/codeReviewAgent.js";
import type { LintRunner, LintRunOutcome } from "../testRuns/lintRunner.js";
import type { WorkspaceManager } from "../workspaces/workspaceManager.js";
import { openDatabase } from "../persistence/database.js";
import { SqliteDocumentStore } from "../persistence/documentStore.js";
import { SqliteRunStore } from "../persistence/runStore.js";
import { AgentRunReview, type RunReview } from "./runReview.js";
import { storedDesignDocuments } from "./fixtures/storedDocuments.js";

const FILES: TemplateFile[] = [
  { path: "src/App.tsx", contents: "export const App = () => null;\n" },
];

const linted = (problems: LintProblem[]): LintRunOutcome => ({
  status: "linted",
  result: {
    profile: "react-node",
    checks: [
      { name: "eslint", ok: problems.length === 0, durationMs: 1, output: "" },
      { name: "tsc", ok: true, durationMs: 1, output: "" },
    ],
    problems,
    durationMs: 2,
  },
  evidence: {
    operationId: "op",
    exitCode: problems.length === 0 ? 0 : 1,
    timedOut: false,
    durationSeconds: 1,
    cost: 0,
    log: "",
    changedFiles: [],
    removedFiles: [],
    withheldFiles: [],
  },
});

function setup(
  options: { lint?: LintRunOutcome; userStandards?: string | null } = {},
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
      "diff --git a/src/App.tsx b/src/App.tsx\n+const d = 1;\n",
  } as unknown as WorkspaceManager;

  const linters: LintRunner = {
    runLinters: async () => options.lint ?? linted([]),
  };
  const reviewCalls: Array<{
    standard: number;
    diff: string;
    linters: number;
  }> = [];
  const agent: CodeReviewAgent = {
    review: async (input) => {
      reviewCalls.push({
        standard: input.standard.length,
        diff: input.diff,
        linters: input.linterFindings.length,
      });
      return { findings: [], unknownRuleIds: [], loop: loopResult() };
    },
  };
  const problems: string[] = [];
  // Tests depend on the interface; only this factory knows the class.
  const review: RunReview = new AgentRunReview({
    documents,
    workspaces,
    profile: () => REACT_NODE,
    linters,
    agent,
    userStandards: async () => options.userStandards ?? null,
    onProblem: (problem) => problems.push(problem),
  });
  return { review, run, problems, reviewCalls };
}

const loopResult = () => ({
  stopReason: "answered" as const,
  answer: "Reviewed.",
  workingMemory: "-",
  iterations: 1,
  toolCalls: 0,
  failedToolCalls: 0,
  usage: { promptTokens: 1, completionTokens: 1 },
  error: null,
});

describe("AgentRunReview.reviewStandard", () => {
  it("is the Stack Profile's baseline when the user has no standards", async () => {
    const { review, run } = setup();

    expect(await review.reviewStandard(run)).toEqual([...BASELINE_RULES]);
  });

  it("layers the user's AGENTS.md on top, and reports what it could not read", async () => {
    const { review, run, problems } = setup({
      userStandards: [
        "## Review Standard",
        "- SEC-09 (blocking): No SQL built by hand.",
        "- LINT-02 (blocking): A warning is a bug.",
        "- Be nice.",
      ].join("\n"),
    });

    const standard = await review.reviewStandard(run);

    expect(standard.find((rule) => rule.id === "LINT-02")?.severity).toBe(
      "blocking",
    );
    expect(standard.at(-1)).toEqual({
      id: "SEC-09",
      severity: "blocking",
      description: "No SQL built by hand.",
    });
    expect(problems).toEqual([expect.stringContaining('"- Be nice."')]);
  });
});

describe("AgentRunReview.runLinters", () => {
  it("turns what the linters found into Findings of this Run's Rules", async () => {
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

    const findings = await review.runLinters(run, BASELINE_RULES);

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

  // Our own tooling failing is not the application's fault.
  it("says a broken Lint Run out loud and blocks nothing", async () => {
    const { review, run, problems } = setup({
      lint: {
        status: "broken",
        problem: "The lint script printed no SDLC_LINT line.",
        evidence: linted([]).evidence,
      },
    });

    expect(await review.runLinters(run, BASELINE_RULES)).toEqual([]);
    expect(problems).toEqual([
      expect.stringContaining("The linters did not run"),
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
    const { review, run, problems } = setup({ lint: broken });

    await review.runLinters(run, BASELINE_RULES);

    expect(problems).toEqual([
      expect.stringContaining("eslint failed without reporting anything"),
    ]);
  });
});

describe("AgentRunReview.review", () => {
  it("gives the agent the Run's Rules, its diff and what the linters found", async () => {
    const { review, run, reviewCalls } = setup();
    const findings = await review.runLinters(run, BASELINE_RULES);

    await review.review(run, BASELINE_RULES, findings);

    expect(reviewCalls).toEqual([
      {
        standard: BASELINE_RULES.length,
        diff: expect.stringContaining("+const d = 1;"),
        linters: 0,
      },
    ]);
  });
});
