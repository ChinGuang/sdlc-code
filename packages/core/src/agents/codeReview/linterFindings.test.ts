// SPDX-License-Identifier: MPL-2.0
import {
  BASELINE_RULES,
  type LintProblem,
  type LintScriptResult,
  type Rule,
} from "@sdlc-code/stack-profiles";
import { describe, expect, it } from "vitest";
import { blockingFindings, nonBlockingFindings } from "./findings.js";
import { findingsFromLint, ruleIdFor } from "./linterFindings.js";

const problem = (overrides: Partial<LintProblem> = {}): LintProblem => ({
  tool: "eslint",
  severity: "error",
  file: "src/App.tsx",
  line: 7,
  rule: "no-unused-vars",
  message: "'total' is defined but never used.",
  ...overrides,
});

const lintResult = (problems: LintProblem[]): LintScriptResult => ({
  profile: "react-node",
  checks: [
    { name: "eslint", ok: problems.length === 0, durationMs: 1, output: "" },
    { name: "tsc", ok: true, durationMs: 1, output: "" },
  ],
  problems,
  durationMs: 2,
});

describe("ruleIdFor", () => {
  it("gives each tool and severity its own Rule", () => {
    expect(ruleIdFor(problem())).toBe("LINT-01");
    expect(ruleIdFor(problem({ severity: "warning" }))).toBe("LINT-02");
    expect(ruleIdFor(problem({ tool: "tsc", rule: "TS2322" }))).toBe("LINT-03");
    // A type error is an error whatever the tool called it.
    expect(ruleIdFor(problem({ tool: "tsc", severity: "warning" }))).toBe(
      "LINT-03",
    );
  });
});

describe("findingsFromLint", () => {
  it("carries the tool's own rule name into the message", () => {
    const { findings } = findingsFromLint(
      lintResult([problem()]),
      BASELINE_RULES,
    );

    expect(findings).toEqual([
      {
        ruleId: "LINT-01",
        file: "src/App.tsx",
        line: 7,
        message: "'total' is defined but never used. (no-unused-vars)",
        severity: "blocking",
        source: "linter",
      },
    ]);
  });

  it("sends errors back and reports warnings in the pull request", () => {
    const { findings } = findingsFromLint(
      lintResult([
        problem(),
        problem({ severity: "warning", rule: "react-hooks/exhaustive-deps" }),
        problem({ tool: "tsc", rule: "TS2322", message: "Type error." }),
      ]),
      BASELINE_RULES,
    );

    expect(blockingFindings(findings).map((finding) => finding.ruleId)).toEqual(
      ["LINT-01", "LINT-03"],
    );
    expect(
      nonBlockingFindings(findings).map((finding) => finding.ruleId),
    ).toEqual(["LINT-02"]);
  });

  // The severity is the Rule's, so a team can decide what blocks their Run.
  it("follows a Review Standard that lowered a linter Rule", () => {
    const lenient: Rule[] = BASELINE_RULES.map((rule) =>
      rule.id === "LINT-01" ? { ...rule, severity: "major" } : rule,
    );

    const { findings } = findingsFromLint(lintResult([problem()]), lenient);

    expect(findings[0]?.severity).toBe("major");
    expect(blockingFindings(findings)).toEqual([]);
  });

  it("says so when a Review Standard no longer has a linter's Rule", () => {
    const without = BASELINE_RULES.filter((rule) => rule.id !== "LINT-02");

    const { findings, unknownRuleIds } = findingsFromLint(
      lintResult([problem({ severity: "warning" })]),
      without,
    );

    expect(findings).toEqual([]);
    expect(unknownRuleIds).toEqual(["LINT-02"]);
  });

  it("names the application itself when a tool named no file", () => {
    const { findings } = findingsFromLint(
      lintResult([problem({ file: "", line: 0, rule: "" })]),
      BASELINE_RULES,
    );

    expect(findings[0]).toMatchObject({
      file: "(the application)",
      line: 0,
      message: "'total' is defined but never used.",
    });
  });

  it("has no Findings for a clean run", () => {
    expect(findingsFromLint(lintResult([]), BASELINE_RULES)).toEqual({
      findings: [],
      unknownRuleIds: [],
    });
  });
});
