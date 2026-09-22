/**
 * What happens after a Task's Issue Reports are routed back to it (CONTEXT.md
 * "Retry Budget", "Loop", "Token Budget"; UML diagram 7): retry, or escalate.
 * Checked in this order, so the most specific reason is the one reported:
 *   Loop         the same failure as earlier in this Task: escalate at once
 *   Token Budget nothing left to spend on another attempt
 *   Retry Budget this Task has looped back as often as it may
 */
import { isLoop, type IssueReport } from "../agents/testing/issueReports.js";
import type { EscalationTrigger } from "../domain/runLifecycle.js";

/** Default Retry Budget per Task (CONTEXT.md). */
export const DEFAULT_RETRY_BUDGET = 3;

export type RetryInput = {
  /** The Issue Reports routed to this Task now. */
  reports: readonly IssueReport[];
  /** Every Issue Report routed to this Task on earlier attempts. */
  earlier: readonly IssueReport[];
  /** How many times the Task has already looped back. */
  retries: number;
  retryBudget?: number;
  /** Tokens left in the Run's Token Budget. */
  tokensRemaining: number;
};

export type RetryDecision =
  | { action: "retry" }
  | {
      action: "escalate";
      trigger: Extract<
        EscalationTrigger,
        "loop" | "tokenBudget" | "retryBudget"
      >;
      summary: string;
    };

export function decideRetry({
  reports,
  earlier,
  retries,
  retryBudget = DEFAULT_RETRY_BUDGET,
  tokensRemaining,
}: RetryInput): RetryDecision {
  const looping = reports.find((report) => isLoop(report, earlier));
  if (looping)
    return {
      action: "escalate",
      trigger: "loop",
      summary: `The same failure came back after a fix: ${looping.failingTest ?? `${looping.step} step`}: ${looping.error}`,
    };
  if (tokensRemaining <= 0)
    return {
      action: "escalate",
      trigger: "tokenBudget",
      summary: "The Run's Token Budget is spent.",
    };
  if (retries >= retryBudget)
    return {
      action: "escalate",
      trigger: "retryBudget",
      summary: `Still failing after ${retries} ${retries === 1 ? "retry" : "retries"}: ${reports
        .map((report) => report.failingTest ?? `${report.step} step`)
        .join(", ")}`,
    };
  return { action: "retry" };
}
