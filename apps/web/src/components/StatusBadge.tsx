import type { RunSummary } from "../api/types.js";
import { statusBadge } from "../run/view.js";

/** A Run's status as a coloured pill: blue while working, amber or purple
 * while waiting for a person, red when stopped. */
export function StatusBadge({
  run,
  detail,
}: {
  run: Pick<RunSummary, "status" | "pullRequest"> &
    Partial<Pick<RunSummary, "waitingFor">>;
  /** Appended after a dot, e.g. "Slice 2". */
  detail?: string | null;
}) {
  const { label, tone } = statusBadge(run);
  return (
    <span className={`badge tone-${tone}`} data-tone={tone}>
      {detail ? `${label} · ${detail}` : label}
    </span>
  );
}
