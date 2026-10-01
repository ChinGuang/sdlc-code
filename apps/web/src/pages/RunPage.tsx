import { useState } from "react";
import type { RunsApi } from "../api/client.js";
import type { RunDetail } from "../api/types.js";
import { ActivityFeed } from "../components/ActivityFeed.js";
import { BudgetCard } from "../components/BudgetCard.js";
import { DesignGate } from "../components/DesignGate.js";
import { EscalationDialog } from "../components/EscalationDialog.js";
import { IssueCard } from "../components/IssueCard.js";
import { PhaseStepper } from "../components/PhaseStepper.js";
import { ReviewPanel } from "../components/ReviewPanel.js";
import { SlicePlan } from "../components/SlicePlan.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { runHref, RUNS_HREF, type RunTab } from "../router.js";
import { useRun } from "../run/useRun.js";
import { currentSlice, shortId, triggerText } from "../run/view.js";

const FINISHED = new Set(["done", "failed", "aborted"]);

const TABS: Array<{ tab: RunTab; label: string }> = [
  { tab: "overview", label: "Overview" },
  { tab: "designGate", label: "Design Gate" },
  { tab: "review", label: "Code Review & PR" },
];

/** A tab's dot: a person is needed there, it is behind them, or not yet. */
function tabTone(tab: RunTab, run: RunDetail): string {
  switch (tab) {
    case "overview":
      return run.waiting.for === "escalation" ? "red" : "green";
    case "designGate":
      if (run.waiting.for === "designGate") return "amber";
      return run.mode === "gated" &&
        run.documents.length > 0 &&
        run.documents.every((document) => document.status === "approved")
        ? "green"
        : "";
    case "review":
      if (run.waiting.for === "prGate") return "purple";
      return run.status === "done" ? "green" : "";
  }
}

/** Boards 02 to 05: one Run, live, and the decisions it waits for. */
export function RunPage({
  api,
  runId,
  tab = "overview",
  refreshDelayMs,
}: {
  api: RunsApi;
  runId: string;
  tab?: RunTab;
  refreshDelayMs?: number;
}) {
  const { detail, events, testRun, error, accept } = useRun(api, runId, {
    refreshDelayMs,
  });
  // Opens by itself for each Escalation; Cancel puts only that one aside.
  const [setAside, setSetAside] = useState<string | null>(null);
  // The Escalation last answered here: one after it may be the Run stopping
  // again at once, which the person must be told.
  const [answered, setAnswered] = useState<string | null>(null);

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
  const escalation = escalationKey(detail);
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
          {escalation && (
            <button
              type="button"
              className="button small-button"
              onClick={() => setSetAside(null)}
            >
              Decide…
            </button>
          )}
          {!FINISHED.has(detail.status) && (
            <CancelRun run={detail} api={api} onDecided={accept} />
          )}
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <nav className="tabs" aria-label="Run">
        {TABS.map((one) => (
          <a
            key={one.tab}
            href={runHref(runId, one.tab)}
            aria-current={one.tab === tab ? "page" : undefined}
          >
            <span className={`dot ${tabTone(one.tab, detail)}`} />
            {one.label}
          </a>
        ))}
      </nav>
      {tab === "designGate" ? (
        <DesignGate run={detail} api={api} onDecided={accept} />
      ) : tab === "review" ? (
        <ReviewPanel
          run={detail}
          testRun={testRun}
          api={api}
          onDecided={accept}
        />
      ) : (
        <>
          <PhaseStepper run={detail} />
          <Waiting run={detail} api={api} onDecided={accept} />
          <div className="overview">
            <div className="column">
              <SlicePlan run={detail} />
            </div>
            <div className="column">
              <IssueCard testRun={testRun} />
              <BudgetCard run={detail} />
              <ActivityFeed
                events={events}
                slices={detail.slices}
                live={!FINISHED.has(detail.status)}
              />
            </div>
          </div>
        </>
      )}
      {escalation && escalation !== setAside && (
        <EscalationDialog
          key={escalation}
          run={detail}
          api={api}
          stoppedAgain={answered !== null && answered !== escalation}
          onDecided={(next) => {
            setAnswered(escalation);
            accept(next);
          }}
          onClose={() => setSetAside(escalation)}
        />
      )}
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

/**
 * Which Escalation the Run waits at, if any: a later one is a new question,
 * even when it reads the same, so a dialog put aside for an earlier one opens
 * again.
 */
function escalationKey(run: RunDetail): string | null {
  return run.waiting.for === "escalation" ? run.waiting.id : null;
}

/** What a person is being asked, with the way to answer it, or why the Run stopped. */
function Waiting({
  run,
  api,
  onDecided,
}: {
  run: RunDetail;
  api: RunsApi;
  onDecided: (detail: RunDetail) => void;
}) {
  const { waiting, failure } = run;
  if (waiting.for === "designRetry")
    return (
      <DesignFailed
        run={run}
        problem={waiting.problem}
        api={api}
        onDecided={onDecided}
      />
    );
  if (waiting.for === "designGate")
    return (
      <section className="card waiting" aria-label="Waiting">
        <strong>Waiting for you at the Design Gate.</strong>{" "}
        <span className="muted">
          {waiting.documents.length} documents to approve or send back.
        </span>{" "}
        <a href={runHref(run.id, "designGate")}>Review the documents</a>
      </section>
    );
  if (waiting.for === "prGate")
    return (
      <section className="card waiting" aria-label="Waiting">
        <strong>Waiting for you at the PR Gate.</strong>{" "}
        <a href={runHref(run.id, "review")}>Review the findings</a>
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

/**
 * A gated Run whose design failed waits in designing until a person asks for
 * another try (T24f): said here, with the button that asks, rather than a
 * "Designing" that never moves.
 */
function DesignFailed({
  run,
  problem,
  api,
  onDecided,
}: {
  run: RunDetail;
  problem: string;
  api: RunsApi;
  onDecided: (detail: RunDetail) => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = async () => {
    setSending(true);
    setError(null);
    try {
      onDecided(await api.retryDesign(run.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSending(false);
    }
  };
  return (
    <section className="card issue" aria-label="Design failed">
      <strong className="text-red">The design failed.</strong>{" "}
      <span className="muted">{problem}</span>
      <p className="small faint">
        Nothing runs until you try again; it designs again what is missing, with
        any changes you asked for.
      </p>
      <button
        type="button"
        className="button primary"
        disabled={sending}
        onClick={retry}
      >
        {sending ? "Starting…" : "Retry design"}
      </button>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

/**
 * A person stops the Run, whatever it is doing (T24g). Asked first, because it
 * cannot be undone; work under way stops at its next model turn.
 */
function CancelRun({
  run,
  api,
  onDecided,
}: {
  run: RunDetail;
  api: RunsApi;
  onDecided: (detail: RunDetail) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [draftPr, setDraftPr] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    setSending(true);
    setError(null);
    try {
      onDecided(await api.abortRun(run.id, draftPr));
      setAsking(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSending(false);
    }
  };
  if (!asking)
    return (
      <button
        type="button"
        className="button small-button danger-text"
        onClick={() => setAsking(true)}
      >
        Cancel run…
      </button>
    );
  return (
    <div className="card cancel-run" role="group" aria-label="Cancel run">
      <strong>Cancel this Run?</strong>
      <p className="small muted">
        {run.advancing
          ? "It stops after the model turn under way; nothing new starts."
          : "It stops now."}{" "}
        This cannot be undone.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={draftPr}
          onChange={(event) => setDraftPr(event.target.checked)}
        />
        <span>Open a Draft PR with the passed slices</span>
      </label>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-actions">
        <button
          type="button"
          className="button"
          onClick={() => setAsking(false)}
        >
          Keep running
        </button>
        <button
          type="button"
          className="button danger-fill"
          disabled={sending}
          onClick={cancel}
        >
          {sending ? "Cancelling…" : "Cancel run"}
        </button>
      </div>
    </div>
  );
}
