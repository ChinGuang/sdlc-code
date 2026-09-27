import type { Rule } from "@sdlc-code/stack-profiles";
import { describe, expect, it } from "vitest";
import {
  layerReviewStandard,
  overriddenRuleIds,
  parseUserRules,
} from "./reviewStandard.js";

const BASELINE: Rule[] = [
  { id: "CLEAN-01", description: "Names say what the thing is.", severity: "minor" },
  { id: "SEC-01", description: "No secrets in code.", severity: "blocking" },
];

const agentsMd = (body: string) =>
  `# AGENTS.md\n\nHow to work in this repository.\n\n## Review Standard\n\n${body}\n\n## Other notes\n\n- Not a Rule at all.\n`;

describe("parseUserRules", () => {
  it("reads a Rule per list item under the Review Standard heading", () => {
    const { rules, problems } = parseUserRules(
      agentsMd(
        [
          "- SEC-05 (blocking): No SQL is built by string concatenation.",
          "- CLEAN-01 (major): Names say what the thing is, in full words.",
        ].join("\n"),
      ),
    );

    expect(problems).toEqual([]);
    expect(rules).toEqual([
      {
        id: "SEC-05",
        severity: "blocking",
        description: "No SQL is built by string concatenation.",
      },
      {
        id: "CLEAN-01",
        severity: "major",
        description: "Names say what the thing is, in full words.",
      },
    ]);
  });

  it("stops at the next heading, so other sections are prose", () => {
    const { rules } = parseUserRules(
      agentsMd("- SEC-05 (blocking): No string-built SQL."),
    );

    expect(rules.map((rule) => rule.id)).toEqual(["SEC-05"]);
  });

  it("has no Rules when the file has no Review Standard, which is normal", () => {
    expect(
      parseUserRules("# AGENTS.md\n\nRun `pnpm test` before pushing.\n"),
    ).toEqual({ rules: [], problems: [] });
  });

  it("says what is wrong with a list item it cannot read", () => {
    const { rules, problems } = parseUserRules(
      agentsMd(
        [
          "- Write good code.",
          "- SEC-06 (critical): Something.",
          "- SEC-07 (major): A real Rule.",
        ].join("\n"),
      ),
    );

    expect(rules.map((rule) => rule.id)).toEqual(["SEC-07"]);
    expect(problems).toEqual([
      '"- Write good code." is not a Rule; write "- ID (severity): what must hold".',
      '"SEC-06" has severity "critical"; use minor, major, blocking.',
    ]);
  });

  it("ignores prose paragraphs between the Rules", () => {
    const { rules, problems } = parseUserRules(
      agentsMd(
        [
          "These are ours, on top of the profile's.",
          "",
          "- SEC-05 (blocking): No string-built SQL.",
        ].join("\n"),
      ),
    );

    expect(rules.map((rule) => rule.id)).toEqual(["SEC-05"]);
    expect(problems).toEqual([]);
  });
});

describe("layerReviewStandard", () => {
  it("replaces a baseline Rule with the user's version of the same ID", () => {
    const layered = layerReviewStandard(BASELINE, [
      { id: "CLEAN-01", description: "Names are full words.", severity: "major" },
    ]);

    expect(layered).toEqual([
      { id: "CLEAN-01", description: "Names are full words.", severity: "major" },
      BASELINE[1],
    ]);
  });

  it("adds a Rule the baseline does not have, after the baseline's", () => {
    const own: Rule = {
      id: "SEC-05",
      description: "No string-built SQL.",
      severity: "blocking",
    };

    expect(layerReviewStandard(BASELINE, [own])).toEqual([...BASELINE, own]);
  });

  it("keeps the baseline as it is when the user has no Rules", () => {
    expect(layerReviewStandard(BASELINE, [])).toEqual(BASELINE);
  });

  it("lets a user lower a blocking Rule, which stops it sending work back", () => {
    const [rule] = layerReviewStandard(BASELINE, [
      { id: "SEC-01", description: "No secrets in code.", severity: "minor" },
    ]).filter((layered) => layered.id === "SEC-01");

    expect(rule?.severity).toBe("minor");
  });
});

describe("overriddenRuleIds", () => {
  it("names the baseline Rules the user replaced, and not their new ones", () => {
    expect(
      overriddenRuleIds(BASELINE, [
        { id: "SEC-01", description: "x", severity: "minor" },
        { id: "SEC-05", description: "y", severity: "major" },
      ]),
    ).toEqual(["SEC-01"]);
  });
});
