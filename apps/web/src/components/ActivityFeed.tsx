// SPDX-License-Identifier: MPL-2.0
import type { RunEvent, RunSlice } from "../api/types.js";
import { describe } from "../run/view.js";

/** What the Run's agents are doing, newest first, as the stream says it. */
export function ActivityFeed({
  events,
  slices,
  live,
}: {
  events: RunEvent[];
  slices: RunSlice[];
  /** Whether more can still arrive: the Run has not finished. */
  live: boolean;
}) {
  const lines = events
    .map((event) => ({ event, line: describe(event, slices) }))
    .filter((entry) => entry.line !== null)
    .reverse();
  return (
    <section className="card" aria-label="Activity">
      <h2>
        Activity
        {live && (
          <span className="live aside">
            <span className="dot green" />
            live
          </span>
        )}
      </h2>
      {lines.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <ol className="feed">
          {lines.map(({ event, line }) => (
            <li key={event.seq}>
              <span className={`dot ${line!.tone === "red" ? "red" : ""}`} />
              <span>
                <span className="who">{line!.who}</span>{" "}
                <span className={line!.tone === "red" ? "text-red" : "muted"}>
                  {line!.what}
                </span>
              </span>
              <time dateTime={event.happenedAt}>
                {new Date(event.happenedAt).toLocaleTimeString([], {
                  hour12: false,
                })}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
