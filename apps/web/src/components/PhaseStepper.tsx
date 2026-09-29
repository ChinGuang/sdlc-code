import type { RunDetail } from "../api/types.js";
import { phases, type PhaseState } from "../run/view.js";

const MARK: Record<PhaseState, (index: number) => string> = {
  done: () => "✓",
  current: (index) => String(index + 1),
  upcoming: (index) => String(index + 1),
  stopped: () => "!",
  skipped: () => "–",
};

const SPOKEN: Record<PhaseState, string> = {
  done: "done",
  current: "in progress",
  upcoming: "not yet",
  stopped: "stopped here",
  skipped: "skipped in auto mode",
};

/** Design → Design Gate → Slices → Code Review → PR Gate. */
export function PhaseStepper({
  run,
}: {
  run: Pick<RunDetail, "status" | "mode" | "slices">;
}) {
  return (
    <ol className="stepper" aria-label="Phases">
      {phases(run).map((phase, index) => (
        <li
          key={phase.key}
          data-state={phase.state}
          aria-current={phase.state === "current" ? "step" : undefined}
          title={SPOKEN[phase.state]}
        >
          <span className="mark" aria-hidden="true">
            {MARK[phase.state](index)}
          </span>
          <span>
            {phase.label}
            <span className="sr-only">{` (${SPOKEN[phase.state]})`}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
