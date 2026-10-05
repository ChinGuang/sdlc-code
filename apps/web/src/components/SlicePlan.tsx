// SPDX-License-Identifier: MPL-2.0
import type { RunDetail } from "../api/types.js";
import { currentSlice, lanes, sliceNote } from "../run/view.js";

/**
 * The approved Slice Plan, in order. The Slice being built opens up into its
 * two lanes, Backend and Frontend, which merge into one Test Run.
 */
export function SlicePlan({
  run,
}: {
  run: Pick<RunDetail, "slices" | "tasks" | "mode" | "status" | "documents">;
}) {
  const current = currentSlice(run.slices);
  // Saved while designing, so a plan is only approved once its document is.
  const approved =
    run.mode === "gated" &&
    run.documents.some(
      (document) =>
        document.kind === "slicePlan" && document.status === "approved",
    );
  return (
    <section className="card" aria-label="Slice plan">
      <h2>
        Slice plan
        <span className="aside">
          {run.slices.length === 0
            ? "Not planned yet"
            : `${approved ? "Approved at Design Gate · " : ""}${run.slices.length} slices`}
        </span>
      </h2>
      {run.slices.length === 0 ? (
        <p className="muted">
          The System Design Agent writes the Slice Plan while the Run designs.
        </p>
      ) : (
        <ol className="slices">
          {run.slices.map((slice, index) => {
            const note = sliceNote(slice, run.tasks);
            const isCurrent = slice.id === current?.id;
            return (
              <li
                key={slice.id}
                className="slice"
                data-current={isCurrent}
                aria-label={`Slice ${index + 1}: ${slice.title}`}
              >
                <div className="slice-head">
                  <span className="name mono">Slice {index + 1}</span>
                  <span>{slice.title}</span>
                  {slice.isWalkingSkeleton && (
                    <span className="chip">walking skeleton</span>
                  )}
                  <span
                    className={`note text-${note.tone}${slice.status === "passed" ? " mono" : ""}`}
                  >
                    {note.label}
                  </span>
                </div>
                {isCurrent && (
                  <>
                    <div className="lanes">
                      {lanes(slice, run.tasks, run.status).map((lane) => (
                        <div
                          key={lane.role}
                          className="lane"
                          aria-label={lane.name}
                        >
                          <span className="who">{lane.name}</span>
                          <span className={`text-${lane.tone}`}>
                            {lane.status}
                          </span>
                          <span className="faint">
                            {lane.steps === 1
                              ? "1 Step done"
                              : `${lane.steps} Steps done`}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div
                      className="merge"
                      data-active={slice.status === "testing"}
                    >
                      ↓ merge → Test Run in Nebius Sandbox (from Base Snapshot)
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
