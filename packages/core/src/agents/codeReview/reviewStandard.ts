// SPDX-License-Identifier: MPL-2.0
/**
 * The layered Review Standard (CONTEXT.md): the Stack Profile's baseline Rules,
 * extended or overridden by the user's own, which they write in an `AGENTS.md`
 * in their Target Repo — the file coding agents already read by convention.
 *
 * A user's Rule with a baseline ID replaces that Rule, which is how a team
 * lowers `CLEAN-01` to minor or raises a Rule to blocking. A new ID is added.
 * Everything else the file says is prose for people, and is ignored here.
 *
 * The format is one Markdown list item per Rule:
 *
 *   ## Review Standard
 *   - SEC-05 (blocking): No SQL is built by string concatenation.
 *   - CLEAN-01 (minor): Names say what the thing is.
 */
import { RULE_SEVERITIES, type Rule } from "@sdlc-code/stack-profiles";

/** The heading whose list items are Rules; anything else in the file is prose. */
const RULES_HEADING = /^#{1,6}\s+review standard\s*$/i;
const HEADING = /^#{1,6}\s+/;
/** "- SEC-05 (blocking): No SQL is built by string concatenation." */
const RULE_LINE = /^[-*]\s+([A-Z][A-Z0-9]*-\d+)\s*\(([a-z]+)\)\s*:\s*(.+)$/;

export type UserRules = {
  rules: Rule[];
  /** Lines under the heading that do not read as a Rule, for the user to fix. */
  problems: string[];
};

/**
 * The Rules in a user's `AGENTS.md`. A file with no Review Standard section has
 * no Rules, which is not a problem: most repositories will not have one.
 */
export function parseUserRules(markdown: string): UserRules {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => RULES_HEADING.test(line.trim()));
  if (start === -1) return { rules: [], problems: [] };

  const rules: Rule[] = [];
  const problems: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const text = line.trim();
    if (HEADING.test(text)) break;
    if (text === "") continue;
    if (!/^[-*]\s+/.test(text)) continue;
    const match = RULE_LINE.exec(text);
    if (!match) {
      problems.push(
        `"${text}" is not a Rule; write "- ID (severity): what must hold".`,
      );
      continue;
    }
    const [, id, severity, description] = match;
    if (!isSeverity(severity!)) {
      problems.push(
        `"${id!}" has severity "${severity!}"; use ${RULE_SEVERITIES.join(", ")}.`,
      );
      continue;
    }
    rules.push({ id: id!, severity, description: description!.trim() });
  }
  return { rules, problems: dedupe(problems) };
}

/**
 * The baseline with the user's Rules layered on: same ID replaces, new ID is
 * appended. Baseline order is kept, so the Rules an agent reads stay in the
 * order the Stack Profile meant them to be read in.
 */
export function layerReviewStandard(
  baseline: readonly Rule[],
  userRules: readonly Rule[],
): Rule[] {
  const overrides = new Map(userRules.map((rule) => [rule.id, rule]));
  const layered = baseline.map((rule) => overrides.get(rule.id) ?? rule);
  const baselineIds = new Set(baseline.map((rule) => rule.id));
  return [...layered, ...userRules.filter((rule) => !baselineIds.has(rule.id))];
}

/** Which of the user's Rules replaced a baseline one, for the Run's record. */
export function overriddenRuleIds(
  baseline: readonly Rule[],
  userRules: readonly Rule[],
): string[] {
  const baselineIds = new Set(baseline.map((rule) => rule.id));
  return userRules
    .map((rule) => rule.id)
    .filter((id) => baselineIds.has(id))
    .sort();
}

function isSeverity(value: string): value is Rule["severity"] {
  return (RULE_SEVERITIES as readonly string[]).includes(value);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
