// SPDX-License-Identifier: MPL-2.0
import { useEffect, useState } from "react";
import type { RunsApi } from "../api/client.js";
import type {
  DocumentKind,
  DocumentView,
  RunDetail,
  RunDocument,
} from "../api/types.js";
import {
  awaiting,
  documentBadge,
  DOCUMENT_NAMES,
  names,
  tally,
  verdictProblems,
  verdictsFrom,
  type Draft,
  type DraftVerdict,
} from "../run/gates.js";
import { DocumentBody, type ScreenShot } from "../documents/DocumentBody.js";
import { ROLE_NAMES } from "../run/view.js";

/**
 * Board 03: a Verdict on each design document. Comments go to the agent that
 * owns the document; a change to a System Design document makes the UI
 * documents built on it Stale, and the Gate says so before it is sent.
 */
export function DesignGate({
  run,
  api,
  onDecided,
}: {
  run: RunDetail;
  api: RunsApi;
  onDecided: (detail: RunDetail) => void;
}) {
  const kinds = awaiting(run);
  // Only what the person chose is kept: until then, the first to judge, so
  // documents that arrive after the tab opened are shown as they come.
  const [chosen, setSelected] = useState<DocumentKind | null>(null);
  const selected = chosen ?? kinds[0] ?? run.documents[0]?.kind ?? null;
  const [draft, setDraft] = useState<Draft>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const atGate = run.waiting.for === "designGate";
  const problems = verdictProblems(kinds, draft);
  const document = run.documents.find((one) => one.kind === selected) ?? null;

  const change = (kind: DocumentKind, next: Partial<DraftVerdict>) =>
    setDraft((current) => ({
      ...current,
      [kind]: { decision: null, comments: "", ...current[kind], ...next },
    }));

  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      onDecided(await api.decideDesign(run.id, verdictsFrom(kinds, draft)));
      setDraft({});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSending(false);
    }
  };

  if (run.documents.length === 0)
    return (
      <section className="card">
        <p className="muted">
          No design documents yet. The design agents write them while the Run
          designs.
        </p>
      </section>
    );

  return (
    <>
      <div className="gate-header">
        <div>
          <h2 className="gate-title">
            Design Gate
            {atGate && (
              <span className="badge tone-amber">Awaiting your verdicts</span>
            )}
          </h2>
          <p className="muted">
            {atGate
              ? "Review each document. Comments go to the agent that owns it."
              : run.mode === "auto"
                ? "An auto Run has no Design Gate: its documents were accepted as written."
                : "Nothing to decide here now."}
          </p>
        </div>
        {atGate && (
          <div className="gate-actions">
            <span className="muted">{tally(run.documents, draft)}</span>
            <button
              type="button"
              className="button primary"
              disabled={sending || problems.length > 0}
              aria-describedby="verdicts-missing"
              onClick={submit}
            >
              {sending ? "Sending…" : "Submit verdicts"}
            </button>
            <span id="verdicts-missing" className="small faint">
              {problems[0] ?? ""}
            </span>
          </div>
        )}
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="gate-grid">
        <DocumentList
          documents={run.documents}
          selected={selected}
          draft={draft}
          onSelect={setSelected}
        />
        {document && (
          <DocumentContent
            api={api}
            runId={run.id}
            document={document}
            slicePlanVersion={
              run.documents.find((one) => one.kind === "slicePlan")?.version ??
              null
            }
            screenshots={run.screenshots.map((shot) => ({
              screen: shot.screen,
              url: api.screenshotUrl(run.id, shot.version, shot.order),
            }))}
            screenshotsKept={run.screenshotsVersion !== null}
          />
        )}
        {document && (
          <VerdictPanel
            document={document}
            judged={atGate && kinds.includes(document.kind)}
            verdict={draft[document.kind]}
            redoneAnyway={kinds.filter(
              (kind) => draft[kind]?.decision === "requestChanges",
            )}
            onChange={(next) => change(document.kind, next)}
          />
        )}
      </div>
    </>
  );
}

function DocumentList({
  documents,
  selected,
  draft,
  onSelect,
}: {
  documents: RunDocument[];
  selected: DocumentKind | null;
  draft: Draft;
  onSelect: (kind: DocumentKind) => void;
}) {
  return (
    <section className="card doc-list" aria-label="Documents">
      <h3 className="eyebrow">Documents</h3>
      <ul>
        {documents.map((document) => {
          const badge = documentBadge(document.status);
          const decision = draft[document.kind]?.decision;
          return (
            <li key={document.kind}>
              <button
                type="button"
                aria-pressed={document.kind === selected}
                onClick={() => onSelect(document.kind)}
              >
                <strong>{DOCUMENT_NAMES[document.kind]}</strong>
                <span className="faint">{ROLE_NAMES[document.ownerAgent]}</span>
                <span className="doc-badges">
                  <span className={`badge tone-${badge.tone}`}>
                    {badge.label}
                  </span>
                  {decision && (
                    <span
                      className={`badge tone-${decision === "approve" ? "green" : "red"}`}
                    >
                      {decision === "approve" ? "You: approve" : "You: changes"}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="cascade">
        <h3>Cascade</h3>
        <p className="muted">
          UI Spec and UI design are built on the System Design documents. They
          become Stale when one of those changes, and are redone before the Gate
          re-opens.
        </p>
      </div>
    </section>
  );
}

/** The document itself, read when it is chosen. */
function DocumentContent({
  api,
  runId,
  document,
  slicePlanVersion,
  screenshots,
  screenshotsKept,
}: {
  api: RunsApi;
  runId: string;
  document: RunDocument;
  /** The API Contract's endpoints are placed in Slices by the Slice Plan. */
  slicePlanVersion: number | null;
  /** The screens as drawn, for the UI design and the UI Spec. */
  screenshots: ScreenShot[];
  /** Whether any were kept for this design, even if every export failed. */
  screenshotsKept: boolean;
}) {
  const [read, setRead] = useState<{
    key: string;
    view: DocumentView | null;
    slicePlan: string | null;
    error: string | null;
  } | null>(null);
  const withPlan = document.kind === "apiContract" && slicePlanVersion !== null;
  const key = `${document.kind}@${document.version}${withPlan ? `+${slicePlanVersion}` : ""}`;

  useEffect(() => {
    let live = true;
    Promise.all([
      api.getDocument(runId, document.kind),
      // Without it the table only loses its Slice column.
      withPlan
        ? api.getDocument(runId, "slicePlan").then(
            (plan) => plan.content,
            () => null,
          )
        : null,
    ]).then(
      ([view, slicePlan]) =>
        live && setRead({ key, view, slicePlan, error: null }),
      (error: unknown) =>
        live &&
        setRead({
          key,
          view: null,
          slicePlan: null,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return () => {
      live = false;
    };
  }, [api, runId, document.kind, key, withPlan]);

  const current = read?.key === key ? read : null;
  return (
    <section
      className="card document"
      aria-label={`${DOCUMENT_NAMES[document.kind]} content`}
    >
      <h2>
        {DOCUMENT_NAMES[document.kind]}
        <span className="aside mono">v{document.version}</span>
      </h2>
      {!current ? (
        <p className="muted">Loading…</p>
      ) : current.error ? (
        <div className="error">{current.error}</div>
      ) : (
        <DocumentBody
          key={key}
          kind={document.kind}
          content={current.view!.content}
          slicePlan={current.slicePlan}
          screenshots={screenshots}
          screenshotsKept={screenshotsKept}
        />
      )}
    </section>
  );
}

function VerdictPanel({
  document,
  judged,
  verdict,
  redoneAnyway,
  onChange,
}: {
  document: RunDocument;
  /** Whether this document is one the person judges now. */
  judged: boolean;
  verdict: DraftVerdict | undefined;
  /** Documents whose own changes are asked for: redone, not made Stale. */
  redoneAnyway: DocumentKind[];
  onChange: (next: Partial<DraftVerdict>) => void;
}) {
  const name = DOCUMENT_NAMES[document.kind];
  const owner = ROLE_NAMES[document.ownerAgent];
  if (!judged)
    return (
      <section className="card verdict" aria-label="Your verdict">
        <h2>{name}</h2>
        <p className="muted">
          {documentBadge(document.status).label}: nothing to decide on it now.
        </p>
      </section>
    );
  // What this document's changes would cause; the header counts the Gate's.
  const stale =
    verdict?.decision === "requestChanges"
      ? document.wouldMakeStale.filter((kind) => !redoneAnyway.includes(kind))
      : [];
  return (
    <section className="card verdict" aria-label="Your verdict">
      <h2>Your verdict</h2>
      <p className="muted small">
        {name} · owner {owner}
      </p>
      <div
        className="segmented verdict-choice"
        role="group"
        aria-label="Verdict"
      >
        <button
          type="button"
          aria-pressed={verdict?.decision === "approve"}
          onClick={() => onChange({ decision: "approve" })}
        >
          Approve
        </button>
        <button
          type="button"
          className="danger"
          aria-pressed={verdict?.decision === "requestChanges"}
          onClick={() => onChange({ decision: "requestChanges" })}
        >
          Request changes
        </button>
      </div>
      <label className="field">
        Comments
        <textarea
          value={verdict?.comments ?? ""}
          placeholder={
            verdict?.decision === "requestChanges"
              ? "What should change, and why."
              : "Optional."
          }
          onChange={(event) => onChange({ comments: event.target.value })}
        />
      </label>
      {stale.length > 0 && (
        <div className="warning" role="status">
          <strong>
            ⚠ {stale.length === 1 ? "1 document" : `${stale.length} documents`}{" "}
            will go stale
          </strong>
          <p>
            {names(stale)} will be redone by the UI Design Agent after the{" "}
            {owner} updates the {name}. You will review every changed document
            again.
          </p>
        </div>
      )}
      <div className="routes">
        <span className="faint small">Routes to</span>
        <span>{owner}</span>
      </div>
    </section>
  );
}
