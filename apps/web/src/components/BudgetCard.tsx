import type { RunDetail } from "../api/types.js";
import {
  currentSlice,
  formatTokens,
  RETRY_BUDGET,
  retriesOf,
} from "../run/view.js";

/** The Token Budget spent so far, and the current Slice's Retry Budget. */
export function BudgetCard({
  run,
}: {
  run: Pick<RunDetail, "tokensUsed" | "tokenBudget" | "slices" | "tasks">;
}) {
  const share = run.tokenBudget > 0 ? run.tokensUsed / run.tokenBudget : 0;
  const slice = currentSlice(run.slices);
  const index = slice ? run.slices.indexOf(slice) : -1;
  const retries = slice ? retriesOf(slice.id, run.tasks) : 0;
  return (
    <section className="card" aria-label="Budget">
      <h2>Budget</h2>
      <div className="budget-row">
        <div className="line">
          <span className="muted">Tokens</span>
          <span className="mono" data-testid="tokens">
            {formatTokens(run.tokensUsed)} / {formatTokens(run.tokenBudget)}
          </span>
        </div>
        <div
          className={`bar ${share >= 0.9 ? "red" : share >= 0.7 ? "amber" : ""}`}
          role="progressbar"
          aria-label="Tokens spent"
          aria-valuemin={0}
          aria-valuemax={run.tokenBudget}
          aria-valuenow={run.tokensUsed}
        >
          <span style={{ width: `${Math.min(100, share * 100)}%` }} />
        </div>
      </div>
      {slice && (
        <div className="budget-row">
          <div className="line">
            <span className="muted">Slice {index + 1} retries</span>
            <span className={`mono ${retries > 0 ? "text-amber" : ""}`}>
              {retries} / {RETRY_BUDGET}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
