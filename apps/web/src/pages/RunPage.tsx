import type { RunsApi } from "../api/client.js";
import type { RunDetail } from "../api/types.js";
import { ActivityFeed } from "../components/ActivityFeed.js";
import { BudgetCard } from "../components/BudgetCard.js";
import { IssueCard } from "../components/IssueCard.js";
import { PhaseStepper } from "../components/PhaseStepper.js";
import { SlicePlan } from "../components/SlicePlan.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { RUNS_HREF } from "../router.js";
import { useRun } from "../run/useRun.js";
import { currentSlice, shortId, triggerText } from "../run/view.js";

const FINISHED = new Set(["done", "failed", "aborted"]);

/** Board 02: one Run, live. */
export function RunPage({
  api,
  runId,
  refreshDelayMs,
}: {
  api: RunsApi;
  runId: string;
  refreshDelayMs?: number;
}) {
  const { detail, events, error } = useRun(api, runId, { refreshDelayMs });

  if (!detail)
    return (
      <>
        <Breadcrumbs runId={runId} title={null} />
        {error ? (
          <div className="error" role="alert">
            {error}
          </div>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </>
    );

  const slice = currentSlice(detail.slices);
  const sliceIndex = slice ? detail.slices.indexOf(slice) : -1;
  return (
    <>
      <Breadcrumbs runId={runId} title={detail.projectRequest} />
      <div className="run-header">
        <div style={{ minWidth: 0 }}>
          <h1>{detail.projectRequest}</h1>
          <div className="meta mono muted">
            {shortId(detail.id)} · {detail.mode === "gated" ? "Gated" : "Auto"}
            {detail.pullRequest && (
              <>
                {" · "}
                <a
                  href={detail.pullRequest.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {detail.pullRequest.draft ? "Draft PR" : "PR"} #
                  {detail.pullRequest.number}
                </a>
              </>
            )}
          </div>
        </div>
        <div className="actions">
          <StatusBadge
            run={detail}
            detail={
              detail.status === "building" && sliceIndex >= 0
                ? `Slice ${sliceIndex + 1}`
                : null
            }
          />
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="tabs" role="tablist">
        <span role="tab" aria-selected="true">
          Overview
        </span>
      </div>
      <PhaseStepper run={detail} />
      <Waiting run={detail} />
      <div className="overview">
        <div className="column">
          <SlicePlan run={detail} />
        </div>
        <div className="column">
          <IssueCard events={events} />
          <BudgetCard run={detail} />
          <ActivityFeed
            events={events}
            slices={detail.slices}
            live={!FINISHED.has(detail.status)}
          />
        </div>
      </div>
    </>
  );
}

function Breadcrumbs({
  runId,
  title,
}: {
  runId: string;
  title: string | null;
}) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumbs">
      <a href={RUNS_HREF}>Runs</a> / {shortId(runId)}
      {title ? ` ${title}` : ""}
    </nav>
  );
}

/** What a person is being asked, or why the Run stopped. */
function Waiting({ run }: { run: RunDetail }) {
  const { waiting, failure } = run;
  if (waiting.for === "designGate")
    return (
      <section className="card waiting" aria-label="Waiting">
        <strong>Waiting for you at the Design Gate.</strong>{" "}
        <span className="muted">
          {waiting.documents.length} documents to approve or send back.
        </span>
      </section>
    );
  if (waiting.for === "prGate")
    return (
      <section className="card waiting" aria-label="Waiting">
        <strong>Waiting for you at the PR Gate.</strong>{" "}
        {waiting.pullRequest && (
          <a href={waiting.pullRequest.url} target="_blank" rel="noreferrer">
            Review PR #{waiting.pullRequest.number}
          </a>
        )}
      </section>
    );
  if (waiting.for === "escalation")
    return (
      <section className="card waiting" aria-label="Waiting">
        <strong>Escalated: {triggerText(waiting.trigger)}.</strong>{" "}
        <span className="muted">{waiting.summary}</span>
      </section>
    );
  if (failure)
    return (
      <section className="card issue" aria-label="Failure">
        <strong className="text-red">
          Stopped: {triggerText(failure.trigger)}.
        </strong>{" "}
        <span className="muted">{failure.summary}</span>
      </section>
    );
  return null;
}
