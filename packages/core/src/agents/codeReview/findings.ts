// SPDX-License-Identifier: MPL-2.0
/**
 * Findings (CONTEXT.md): a Rule violation, from a linter or the Code Review
 * Agent, always citing a Rule ID. Only blocking Findings send work back; the
 * rest travel to the pull request's description (T20).
 *
 * A Finding's severity is the Rule's, not the reporter's: an agent that calls
 * its own Finding blocking cannot make it so, and a user who lowers a Rule's
 * severity lowers every Finding that cites it.
 */
import type { Rule, RuleSeverity } from "@sdlc-code/stack-profiles";
import { z } from "zod";
import type { PullRequestFinding } from "../../delivery/pullRequestText.js";
import type { CodingIssue } from "../coding/codingContext.js";

/** What a reporter says; the severity is looked up from the Rule. */
export const ReportedFindingSchema = z.strictObject({
  ruleId: z.string().min(1),
  /** The application file, as the Workspace spells it. */
  file: z.string().min(1),
  /** 1-based; 0 when the Finding is about the file as a whole. */
  line: z.number().int().min(0).default(0),
  /** What is wrong, in one sentence. */
  message: z.string().min(1),
  /** What to do instead; omitted when the message says it. */
  suggestion: z.string().optional(),
  /**
   * The line of code the Finding is about, copied from the diff (T25a). A
   * blocking Finding must have one the diff shows: it is what tells a real
   * problem from an invented one.
   */
  quote: z.string().optional(),
});

export type ReportedFinding = z.infer<typeof ReportedFindingSchema>;

/** A Finding with the severity its Rule gives it. */
export type Finding = ReportedFinding & {
  severity: RuleSeverity;
  /** Where it came from, for the Run's record and the description. */
  source: "linter" | "codeReview";
};

/**
 * Findings for what was reported, with the severity of the Rule each cites.
 * A Finding citing a Rule the Review Standard does not have is dropped: a
 * reviewer inventing an ID would otherwise invent a severity with it.
 */
export function findingsFor(
  reported: readonly ReportedFinding[],
  standard: readonly Rule[],
  source: Finding["source"],
): { findings: Finding[]; unknownRuleIds: string[] } {
  const rules = new Map(standard.map((rule) => [rule.id, rule]));
  const findings: Finding[] = [];
  const unknownRuleIds: string[] = [];
  for (const finding of reported) {
    const rule = rules.get(finding.ruleId);
    if (!rule) {
      unknownRuleIds.push(finding.ruleId);
      continue;
    }
    findings.push({ ...finding, severity: rule.severity, source });
  }
  return { findings, unknownRuleIds };
}

/** Findings that send the Slice back to its Coding Agents. */
export function blockingFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => finding.severity === "blocking");
}

/** The rest: they are reported in the pull request, not fixed first. */
export function nonBlockingFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => finding.severity !== "blocking");
}

/** A Finding as the pull request's description lists it (T20). */
export function asPullRequestFinding(finding: Finding): PullRequestFinding {
  return {
    ruleId: finding.ruleId,
    location:
      finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file,
    message: finding.message,
    ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
  };
}

/**
 * What a Coding Agent is told to fix, in the shape Issue Reports already use
 * (codingContext.ts), so a Finding and a failing test read the same way.
 */
export function asCodingIssue(finding: Finding): CodingIssue {
  const where =
    finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
  return {
    summary: `${finding.ruleId} (${finding.severity}) in ${where}: ${finding.message}`,
    evidence: finding.suggestion
      ? `${finding.message}\nSuggestion: ${finding.suggestion}`
      : finding.message,
  };
}
