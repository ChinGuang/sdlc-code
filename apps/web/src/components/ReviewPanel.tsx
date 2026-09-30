import { useState } from "react";
import type { RunsApi } from "../api/client.js";
import type { RunDetail, RunEvent, Severity } from "../api/types.js";
import {
  countBySeverity,
  DOCUMENT_NAMES,
  locationOf,
  SEVERITIES,
  severityTone,
} from "../run/gates.js";

type TestRunEvent = Extract<RunEvent, { type: "testRun" }>;

/**
 * Board 04: what the review found, and the PR Gate. Blocking Findings were
 * sent back to be fixed; the rest are in the pull request's description.
 * Approving marks the Run done; merging stays on GitHub.
 */
export function ReviewPanel({
  run,
  testRun,
  api,
  onDecided,
}: {
  run: RunDetail;
  testRun: TestRunEvent | null;
  api: RunsApi;
  onDecided: (detail: RunDetail) => void;
}) {
  const atGate = run.waiting.for === "prGate";
  const latest = run.reviews.at(-1) ?? null;
  const findings = latest?.findings ?? [];
  const counts = countBySeverity(findings);
  const passed = run.slices.filter((slice) => slice.status === "passed");
  const through = run.slices.filter(
    (slice) => slice.status === "passed" || slice.status === "skipped",
  );
  const fromLinters = findings.filter((finding) => finding.source === "linter");
  const sentBack = run.reviews
    .slice(0, -1)
    .flatMap((review) =>
      review.findings.filter((finding) => finding.severity === "blocking"),
    );

  return (
    <>
      <div className="gate-header">
        <div>
          <h2 className="gate-title">
            PR Gate
            {atGate && (
              <span className="badge tone-purple">Awaiting your review</span>
            )}
          </h2>
          <p className="muted">
            {run.pullRequest
              ? `PR #${run.pullRequest.number}${run.pullRequest.draft ? " (draft)" : ""}`
              : "No pull request yet."}
          </p>
        </div>
        {atGate && (
          <PrDecision runId={run.id} api={api} onDecided={onDecided} />
        )}
      </div>
      <div className="stats">
        <Stat
          label="Slices"
          value={`${through.length} / ${run.slices.length}`}
          tone={
            run.slices.length > 0 && passed.length === run.slices.length
              ? "green"
              : null
          }
          note={
            run.slices.length > 0 && passed.length === run.slices.length
              ? "all passed"
              : `${passed.length} passed`
          }
        />
        <Stat
          label="Tests"
          value={testRun ? testRun.status : "—"}
          note={testRun?.summary ?? "no Test Run seen yet"}
          tone={testRun?.status === "passed" ? "green" : testRun ? "red" : null}
        />
        <Stat
          label="Linters"
          value={latest ? `${fromLinters.length} found` : "—"}
          note="ESLint · tsc"
        />
        <Stat
          label="Findings"
          value={
            latest ? SEVERITIES.map((one) => counts[one]).join(" · ") : "—"
          }
          note="blocking · major · minor"
          tone={counts.blocking > 0 ? "red" : counts.major > 0 ? "amber" : null}
        />
      </div>
      <div className="overview">
        <FindingsList run={run} />
        <div className="column">
          <section className="card" aria-label="Review pipeline">
            <h2>Review pipeline</h2>
            <ol className="pipeline">
              <li>
                <strong>Linters</strong>
                <span className="faint">
                  ESLint and tsc, run in the sandbox
                </span>
              </li>
              <li>
                <strong>Code Review Agent</strong>
                <span className="faint">
                  {run.reviews.length === 0
                    ? "Not run yet"
                    : `${run.reviews.length} ${run.reviews.length === 1 ? "review" : "reviews"}`}
                </span>
              </li>
              <li>
                <strong>Blocking findings → Coding Agent</strong>
                <span className="faint">
                  {sentBack.length === 0
                    ? "None sent back"
                    : `${sentBack.length} sent back to be fixed`}
                </span>
              </li>
              <li>
                <strong>Non-blocking → PR description</strong>
                <span className="faint">
                  {counts.major + counts.minor} listed
                </span>
              </li>
            </ol>
            {latest?.problems.map((problem) => (
              <p key={problem} className="text-amber small">
                {problem}
              </p>
            ))}
          </section>
          <PullRequestCard run={run} />
        </div>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  note,
  tone = null,
}: {
  label: string;
  value: string;
  note: string;
  tone?: "green" | "amber" | "red" | null;
}) {
  return (
    <section className="card stat" aria-label={`${label} summary`}>
      <span className="muted small">{label}</span>
      <strong className="stat-value mono">{value}</strong>
      <span className={`small ${tone ? `text-${tone}` : "muted"}`}>{note}</span>
    </section>
  );
}

function FindingsList({ run }: { run: RunDetail }) {
  const [only, setOnly] = useState<Severity | null>(null);
  const findings = run.reviews.at(-1)?.findings ?? [];
  const counts = countBySeverity(findings);
  const shown = only
    ? findings.filter((finding) => finding.severity === only)
    : findings;
  return (
    <section className="card" aria-label="Findings">
      <h2>
        Findings
        <span className="aside">
          Review Standard: Stack Profile baseline + your AGENTS.md
        </span>
      </h2>
      {findings.length === 0 ? (
        <p className="muted">
          {run.reviews.length === 0
            ? "Not reviewed yet. The Code Review Agent reads the diff once every Slice passes."
            : "The last review found nothing."}
        </p>
      ) : (
        <>
          <div className="segmented filters" role="group" aria-label="Show">
            <button
              type="button"
              aria-pressed={only === null}
              onClick={() => setOnly(null)}
            >
              All {findings.length}
            </button>
            {SEVERITIES.filter((severity) => counts[severity] > 0).map(
              (severity) => (
                <button
                  key={severity}
                  type="button"
                  aria-pressed={only === severity}
                  onClick={() => setOnly(severity)}
                >
                  {severity[0]!.toUpperCase() + severity.slice(1)}{" "}
                  {counts[severity]}
                </button>
              ),
            )}
          </div>
          <ul className="findings">
            {shown.map((finding, index) => (
              <li key={`${finding.ruleId}-${locationOf(finding)}-${index}`}>
                <div className="finding-head">
                  <span className="chip rule">{finding.ruleId}</span>
                  <span
                    className={`badge tone-${severityTone(finding.severity)}`}
                  >
                    {finding.severity}
                  </span>
                  <strong>{finding.message}</strong>
                  <span className="aside faint small">
                    {routeOf(finding.severity, run)}
                  </span>
                </div>
                <div className="mono muted small">{locationOf(finding)}</div>
                {finding.suggestion && (
                  <div className="small">→ {finding.suggestion}</div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function PullRequestCard({ run }: { run: RunDetail }) {
  const commits = run.slices
    .map((slice, index) => ({ slice, index }))
    .filter(({ slice }) => slice.commitSha);
  const approved = run.documents.filter(
    (document) => document.status === "approved",
  );
  return (
    <section className="card" aria-label="Pull request">
      <h2>Pull request</h2>
      {run.pullRequest ? (
        <p>
          <a href={run.pullRequest.url} target="_blank" rel="noreferrer">
            #{run.pullRequest.number} {run.projectRequest}
          </a>
          {run.pullRequest.draft && (
            <span className="badge tone-muted">draft</span>
          )}
        </p>
      ) : (
        <p className="muted">Opened once the review passes.</p>
      )}
      {commits.length > 0 && (
        <ul className="commits">
          {commits.map(({ slice, index }) => (
            <li key={slice.id}>
              <span className="mono text-blue">
                {slice.commitSha!.slice(0, 7)}
              </span>
              <span>
                Slice {index + 1} · {slice.title}
              </span>
            </li>
          ))}
        </ul>
      )}
      {approved.length > 0 && (
        <>
          <h3 className="eyebrow">Approved documents</h3>
          <div className="chips">
            {approved.map((document) => (
              <span key={document.kind} className="chip">
                {DOCUMENT_NAMES[document.kind]}
              </span>
            ))}
          </div>
        </>
      )}
      <p className="faint small">
        Approving marks the Run done. Merging stays on GitHub.
      </p>
    </section>
  );
}

/** Approve, or send it back with what should change. */
function PrDecision({
  runId,
  api,
  onDecided,
}: {
  runId: string;
  api: RunsApi;
  onDecided: (detail: RunDetail) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [comments, setComments] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (
    decision: Parameters<RunsApi["decidePullRequest"]>[1],
  ) => {
    setSending(true);
    setError(null);
    try {
      onDecided(await api.decidePullRequest(runId, decision));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="gate-actions column-actions">
      <div className="gate-actions">
        <button
          type="button"
          className="button"
          aria-expanded={asking}
          onClick={() => setAsking(!asking)}
        >
          Request changes
        </button>
        <button
          type="button"
          className="button primary"
          disabled={sending}
          onClick={() => decide({ choice: "approve" })}
        >
          Approve
        </button>
      </div>
      {asking && (
        <form
          className="request-changes"
          onSubmit={(event) => {
            event.preventDefault();
            void decide({
              choice: "requestChanges",
              comments: comments.trim(),
            });
          }}
        >
          <label className="field">
            What should change
            <textarea
              value={comments}
              onChange={(event) => setComments(event.target.value)}
              placeholder="The last Slice is built again with these comments."
            />
          </label>
          <button
            type="submit"
            className="button"
            disabled={sending || comments.trim() === ""}
          >
            Send back
          </button>
        </form>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * Where a Finding of the last review went: a blocking one was sent back, or
 * escalated once the review's attempts ran out; the rest reach the pull
 * request's description, once there is one.
 */
function routeOf(severity: Severity, run: RunDetail): string {
  if (severity === "blocking")
    return run.waiting.for === "escalation" ? "Escalated" : "Sent back";
  return run.pullRequest ? "In PR description" : "Not delivered yet";
}
