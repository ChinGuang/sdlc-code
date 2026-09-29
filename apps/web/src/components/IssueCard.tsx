import type { RunEvent } from "../api/types.js";
import { openIssues } from "../run/view.js";

/**
 * The Issue Reports from the last Test Run, if it did not pass. The Testing
 * Agent only suspects where a fault lies; the Orchestrator decides whose it is.
 */
export function IssueCard({
  testRun: last,
}: {
  testRun: Extract<RunEvent, { type: "testRun" }> | null;
}) {
  const testRun = openIssues(last);
  if (!testRun) return null;
  const broken = testRun.status === "broken";
  return (
    <section className="card issue" aria-label="Issues">
      <h2>
        {broken
          ? "Test Run broke"
          : testRun.issues.length === 1
            ? "1 Issue"
            : `${testRun.issues.length} Issues`}
        <span className="badge tone-amber aside">Open</span>
      </h2>
      <div className="route">Testing Agent → Orchestrator</div>
      {testRun.issues.length > 0 && (
        <ul>
          {testRun.issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      )}
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        Evidence: {testRun.summary}
      </p>
      <footer>
        <span>Suspected by Testing Agent</span>
        <span>Owner decided by Orchestrator</span>
      </footer>
    </section>
  );
}
