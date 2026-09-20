/**
 * What a Stack Profile's test script reports. The script prints human-readable
 * logs, then one marker line with JSON, so a Test Run can read the outcome from
 * noisy sandbox output (install chatter, warnings) without parsing it.
 */
import { z } from "zod";

/** Prefix of the single machine-readable line the script prints last. */
export const RESULT_MARKER = "SDLC_RESULT ";

export const TEST_STEPS = ["install", "unit", "boot", "smoke", "stop"] as const;
export type TestStepName = (typeof TEST_STEPS)[number];

const TestStep = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  durationMs: z.number().min(0),
  /** The tail of the step's output; the whole log stays in the Test Run. */
  output: z.string().default(""),
});

export const TestScriptResultSchema = z.object({
  profile: z.string().min(1),
  passed: z.boolean(),
  steps: z.array(TestStep).min(1),
  durationMs: z.number().min(0),
});

export type TestStep = z.infer<typeof TestStep>;
export type TestScriptResult = z.infer<typeof TestScriptResultSchema>;

export type ParsedTestScript =
  { result: TestScriptResult } | { problem: string };

/**
 * Reads the result from a test script's output. The last marker line wins, so a
 * retry inside the same log cannot be mistaken for the first attempt.
 */
export function parseTestScriptOutput(output: string): ParsedTestScript {
  const line = output
    .split(/\r?\n/)
    .filter((candidate) => candidate.startsWith(RESULT_MARKER))
    .at(-1);
  if (!line)
    return {
      problem: `The test script printed no ${RESULT_MARKER.trim()} line; it did not finish.`,
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(RESULT_MARKER.length));
  } catch (error) {
    return {
      problem: `The ${RESULT_MARKER.trim()} line is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const result = TestScriptResultSchema.safeParse(parsed);
  return result.success
    ? { result: result.data }
    : {
        problem: `The test result is malformed: ${z.prettifyError(result.error)}`,
      };
}

/** The steps that failed, for an Issue Report (T16). */
export function failedSteps(result: TestScriptResult): TestStep[] {
  return result.steps.filter((step) => !step.ok);
}
