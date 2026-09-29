/**
 * What a Stack Profile's lint script reports (T19). Like the test script, it
 * prints noisy output and then one marker line with JSON, so the result can be
 * read out of sandbox logs without parsing them.
 *
 * A problem here is a tool's own complaint, not yet a Finding: the Rule it
 * cites and its severity are decided in core, against the Run's layered Review
 * Standard.
 */
import { z } from "zod";

/** Prefix of the single machine-readable line the script prints last. */
export const LINT_MARKER = "SDLC_LINT ";

export const LINT_TOOLS = ["eslint", "tsc"] as const;
export type LintToolName = (typeof LINT_TOOLS)[number];

const LintProblem = z.object({
  tool: z.enum(LINT_TOOLS),
  /** The tool's own severity: a warning is not an error to the tool. */
  severity: z.enum(["error", "warning"]),
  /** Application-relative, "/"-separated, e.g. "src/App.tsx". */
  file: z.string().default(""),
  /** 1-based; 0 when the tool named no line. */
  line: z.number().int().min(0).default(0),
  /** The tool's rule: an ESLint rule id, or a TypeScript error code. */
  rule: z.string().default(""),
  message: z.string().default(""),
});

const LintCheck = z.object({
  name: z.enum(LINT_TOOLS),
  ok: z.boolean(),
  durationMs: z.number().min(0),
  /** The tail of the tool's own output, for when it failed to run at all. */
  output: z.string().default(""),
});

export const LintScriptResultSchema = z.object({
  profile: z.string().min(1),
  checks: z.array(LintCheck).min(1),
  problems: z.array(LintProblem),
  durationMs: z.number().min(0),
});

export type LintProblem = z.infer<typeof LintProblem>;
export type LintCheck = z.infer<typeof LintCheck>;
export type LintScriptResult = z.infer<typeof LintScriptResultSchema>;

export type ParsedLintScript =
  { result: LintScriptResult } | { problem: string };

/** Reads the result from a lint script's output; the last marker line wins. */
export function parseLintScriptOutput(output: string): ParsedLintScript {
  const line = output
    .split(/\r?\n/)
    .filter((candidate) => candidate.startsWith(LINT_MARKER))
    .at(-1);
  if (!line)
    return {
      problem: `The lint script printed no ${LINT_MARKER.trim()} line; it did not finish.`,
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(LINT_MARKER.length));
  } catch (error) {
    return {
      problem: `The ${LINT_MARKER.trim()} line is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const result = LintScriptResultSchema.safeParse(parsed);
  return result.success
    ? { result: result.data }
    : {
        problem: `The ${LINT_MARKER.trim()} line is not a lint result: ${result.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          )
          .join("; ")}`,
      };
}

/** A tool that could not run at all, which is not the same as finding nothing. */
export function brokenChecks(result: LintScriptResult): LintCheck[] {
  return result.checks.filter(
    (check) =>
      !check.ok &&
      !result.problems.some((problem) => problem.tool === check.name),
  );
}
