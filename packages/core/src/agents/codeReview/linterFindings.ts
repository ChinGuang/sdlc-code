// SPDX-License-Identifier: MPL-2.0
/**
 * What the linters found, as Findings (T19, diagram 8 step 2). Each complaint
 * cites one of the Stack Profile's LINT Rules, and the tool's own rule name
 * travels in the message — so a Coding Agent reads "LINT-01 … (no-unused-vars)"
 * and knows both the Rule it broke and what the tool called it.
 *
 * The severity is the Rule's, which is how a user's AGENTS.md can decide that a
 * warning is worth blocking a Run for, or that an ESLint error is not.
 */
import type {
  LintProblem,
  LintScriptResult,
  Rule,
} from "@sdlc-code/stack-profiles";
import { findingsFor, type Finding, type ReportedFinding } from "./findings.js";

/** Which Rule a complaint cites: one per tool and severity. */
export const LINT_RULE_IDS = {
  eslintError: "LINT-01",
  eslintWarning: "LINT-02",
  typeError: "LINT-03",
} as const;

export function ruleIdFor(problem: LintProblem): string {
  if (problem.tool === "tsc") return LINT_RULE_IDS.typeError;
  return problem.severity === "error"
    ? LINT_RULE_IDS.eslintError
    : LINT_RULE_IDS.eslintWarning;
}

export type LinterFindings = {
  findings: Finding[];
  /** Rule IDs the Review Standard no longer has, e.g. a user removed LINT-02. */
  unknownRuleIds: string[];
};

/**
 * The Findings a Lint Run's result carries: only what the tools reported. A tool
 * that could not run at all reported nothing, and the review says so separately
 * (runReview.ts calls brokenChecks), because our own tooling failing is not a
 * Finding against the application.
 */
export function findingsFromLint(
  result: LintScriptResult,
  standard: readonly Rule[],
): LinterFindings {
  const reported: ReportedFinding[] = result.problems.map((problem) => ({
    ruleId: ruleIdFor(problem),
    file: problem.file || "(the application)",
    line: problem.line,
    message: messageFor(problem),
  }));
  return findingsFor(reported, standard, "linter");
}

/** The tool's own words, with the rule it names, in one sentence. */
function messageFor(problem: LintProblem): string {
  const message = problem.message.trim() || "no message";
  return problem.rule ? `${message} (${problem.rule})` : message;
}
