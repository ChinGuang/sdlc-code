import type { Rule } from "@sdlc-code/stack-profiles";
import { describe, expect, it } from "vitest";
import {
  asCodingIssue,
  asPullRequestFinding,
  blockingFindings,
  findingsFor,
  nonBlockingFindings,
  ReportedFindingSchema,
  type Finding,
} from "./findings.js";

const STANDARD: Rule[] = [
  { id: "SEC-01", description: "No secrets in code.", severity: "blocking" },
  { id: "CLEAN-01", description: "Names say what a thing is.", severity: "minor" },
  { id: "TEST-02", description: "Every screen has a test.", severity: "major" },
];

const reported = {
  ruleId: "SEC-01",
  file: "server/app.ts",
  line: 12,
  message: "The API key is written in the source.",
};

describe("ReportedFindingSchema", () => {
  it("accepts a Finding with a location and a message", () => {
    expect(ReportedFindingSchema.parse(reported)).toEqual({
      ...reported,
      line: 12,
    });
  });

  it("treats a missing line as the file as a whole", () => {
    expect(
      ReportedFindingSchema.parse({ ...reported, line: undefined }).line,
    ).toBe(0);
  });

  it("refuses a Finding with no Rule, no file or no message", () => {
    for (const bad of [
      { ...reported, ruleId: "" },
      { ...reported, file: "" },
      { ...reported, message: "" },
      { ...reported, line: -1 },
      { ...reported, line: 1.5 },
      { ...reported, severity: "blocking" },
    ])
      expect(
        ReportedFindingSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
  });
});

describe("findingsFor", () => {
  it("gives each Finding the severity of the Rule it cites", () => {
    const { findings, unknownRuleIds } = findingsFor(
      [reported, { ...reported, ruleId: "CLEAN-01" }],
      STANDARD,
      "codeReview",
    );

    expect(findings.map((finding) => finding.severity)).toEqual([
      "blocking",
      "minor",
    ]);
    expect(findings[0]?.source).toBe("codeReview");
    expect(unknownRuleIds).toEqual([]);
  });

  // A reviewer inventing a Rule ID would otherwise invent a severity with it.
  it("drops a Finding whose Rule the Review Standard does not have", () => {
    const { findings, unknownRuleIds } = findingsFor(
      [{ ...reported, ruleId: "MADE-UP-09" }],
      STANDARD,
      "codeReview",
    );

    expect(findings).toEqual([]);
    expect(unknownRuleIds).toEqual(["MADE-UP-09"]);
  });

  // The severity is the Rule's, so lowering a Rule lowers its Findings.
  it("follows the Review Standard it is given, not the Rule's usual severity", () => {
    const lowered = STANDARD.map((rule) =>
      rule.id === "SEC-01" ? { ...rule, severity: "minor" as const } : rule,
    );

    const { findings } = findingsFor([reported], lowered, "linter");

    expect(findings[0]?.severity).toBe("minor");
    expect(blockingFindings(findings)).toEqual([]);
  });
});

describe("blocking and non-blocking Findings", () => {
  const findings: Finding[] = [
    { ...reported, severity: "blocking", source: "linter" },
    { ...reported, ruleId: "TEST-02", severity: "major", source: "codeReview" },
    { ...reported, ruleId: "CLEAN-01", severity: "minor", source: "codeReview" },
  ];

  it("sends back only the blocking ones", () => {
    expect(blockingFindings(findings).map((finding) => finding.ruleId)).toEqual([
      "SEC-01",
    ]);
  });

  it("carries the rest to the pull request", () => {
    expect(
      nonBlockingFindings(findings).map((finding) => finding.ruleId),
    ).toEqual(["TEST-02", "CLEAN-01"]);
  });
});

describe("how a Finding is read elsewhere", () => {
  const finding: Finding = {
    ...reported,
    suggestion: "Read it from process.env.",
    severity: "blocking",
    source: "linter",
  };

  it("reads as file and line in a pull request", () => {
    expect(asPullRequestFinding(finding)).toEqual({
      ruleId: "SEC-01",
      location: "server/app.ts:12",
      message: "The API key is written in the source.",
      suggestion: "Read it from process.env.",
    });
    expect(
      asPullRequestFinding({ ...finding, line: 0 }).location,
    ).toBe("server/app.ts");
  });

  it("reads as a problem to fix for a Coding Agent, Rule and all", () => {
    expect(asCodingIssue(finding)).toEqual({
      summary:
        "SEC-01 (blocking) in server/app.ts:12: The API key is written in the source.",
      evidence:
        "The API key is written in the source.\nSuggestion: Read it from process.env.",
    });
  });
});
