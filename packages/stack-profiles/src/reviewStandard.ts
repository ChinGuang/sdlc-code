/**
 * The baseline Review Standard of a Stack Profile (CONTEXT.md "Review Standard"):
 * the Rules the Code Review Agent cites. T19 runs ESLint and tsc first, so
 * these deliberately cover what a linter cannot see. A user adds their own
 * standards on top in T19; only blocking Findings send work back.
 */

export const RULE_SEVERITIES = ["minor", "major", "blocking"] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

export type Rule = {
  /** e.g. "SEC-01"; every Finding cites one. */
  id: string;
  /** What must hold, in one line an agent can check a diff against. */
  description: string;
  severity: RuleSeverity;
};

/** Rule families: what each prefix covers. */
export const RULE_FAMILIES = {
  CLEAN: "Readable code: names, size, dead code",
  REUSE: "Reuse what exists instead of duplicating it",
  STRUCT: "Where code lives and what may depend on what",
  TEST: "What must be tested, and how",
  SEC: "Secrets, input validation and dependencies",
} as const;

export const BASELINE_RULES: readonly Rule[] = [
  {
    id: "CLEAN-01",
    description:
      "Names say what the thing is or does; no abbreviations beyond common ones (id, url, api).",
    severity: "minor",
  },
  {
    id: "CLEAN-02",
    description:
      "No commented-out code, dead files or exports nothing imports; linters see unused locals, not these.",
    severity: "minor",
  },
  {
    id: "CLEAN-03",
    description:
      "A function does one thing: its name describes the whole of what it does, without an 'and'.",
    severity: "minor",
  },
  {
    id: "REUSE-01",
    description:
      "Use the existing helper, component or type instead of writing a second one that does the same.",
    severity: "major",
  },
  {
    id: "REUSE-02",
    description:
      "Shared values (routes, limits, copy) are defined once and imported, not repeated.",
    severity: "major",
  },
  {
    id: "STRUCT-01",
    description:
      "The frontend talks to the API only through the generated client or fetch helpers, never ad-hoc URLs.",
    severity: "major",
  },
  {
    id: "STRUCT-02",
    description:
      "Server code keeps routes thin: validation, then a service function that holds the logic.",
    severity: "major",
  },
  {
    id: "STRUCT-03",
    description:
      "Database access goes through Prisma in the server only; the frontend never imports it.",
    severity: "blocking",
  },
  {
    id: "TEST-01",
    description:
      "Every endpoint in the API Contract has a test that calls it and asserts its response shape.",
    severity: "blocking",
  },
  {
    id: "TEST-02",
    description:
      "Every screen in the UI Spec has a test that renders it and asserts its main elements.",
    severity: "major",
  },
  {
    id: "TEST-03",
    description:
      "Tests assert behaviour, not implementation details, and do not call the network.",
    severity: "major",
  },
  {
    id: "SEC-01",
    description:
      "No secrets, tokens or credentials in code, tests or fixtures; they come from the environment.",
    severity: "blocking",
  },
  {
    id: "SEC-02",
    description:
      "Every request body and query parameter is validated before use (zod on the server).",
    severity: "blocking",
  },
  {
    id: "SEC-03",
    description:
      "Errors returned to the client carry no stack traces, SQL or internal paths.",
    severity: "major",
  },
  {
    id: "SEC-04",
    description:
      "No new runtime dependency unless the Task asks for it; prefer what the template already has.",
    severity: "major",
  },
];

const ID_PATTERN = new RegExp(
  `^(${Object.keys(RULE_FAMILIES).join("|")})-\\d{2}$`,
);

/** Problems with a set of Rules; empty when they are usable as a standard. */
export function ruleProblems(rules: readonly Rule[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!ID_PATTERN.test(rule.id))
      problems.push(
        `Rule id "${rule.id}" must be a family and number, e.g. "SEC-01".`,
      );
    if (seen.has(rule.id)) problems.push(`Rule ${rule.id} is defined twice.`);
    seen.add(rule.id);
    if (rule.description.trim() === "")
      problems.push(`Rule ${rule.id} has no description.`);
  }
  return problems;
}

/** Only blocking Findings send work back (CONTEXT.md "Finding"). */
export function isBlocking(rule: Rule): boolean {
  return rule.severity === "blocking";
}
