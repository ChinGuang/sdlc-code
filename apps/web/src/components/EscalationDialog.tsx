import { useState } from "react";
import type { RunsApi } from "../api/client.js";
import type {
  DocumentKind,
  EscalationResolution,
  RunDetail,
} from "../api/types.js";
import { DOCUMENT_NAMES, escalationTitle } from "../run/gates.js";
import {
  formatTokens,
  RETRY_BUDGET,
  retriesOf,
  ROLE_NAMES,
  triggerText,
} from "../run/view.js";

type Choice = EscalationResolution["choice"];

const CHOICES: Array<{ choice: Choice; label: string; note: string }> = [
  {
    choice: "retryWithHint",
    label: "Retry with a hint",
    note: "Give the agents guidance and a fresh Retry Budget",
  },
  {
    choice: "editDocuments",
    label: "Edit approved documents",
    note: "Re-opens the Design Gate",
  },
  {
    choice: "skipSlice",
    label: "Skip this slice",
    note: "Build on without it",
  },
  { choice: "abort", label: "Abort run", note: "Stop the Run" },
];

const CONFIRM: Record<Choice, string> = {
  retryWithHint: "Retry with hint",
  editDocuments: "Send to the owners",
  skipSlice: "Skip slice",
  abort: "Abort run",
};

/**
 * Board 05: the Run stopped for a person. What stopped it, what kept failing
 * and what the agents tried, then one of the four ways on (CONTEXT.md
 * "Escalation"). Aborting offers a Draft PR of the Slices that passed, ticked
 * unless the person unticks it.
 */
export function EscalationDialog({
  run,
  api,
  onDecided,
  onClose,
}: {
  run: RunDetail;
  api: RunsApi;
  onDecided: (detail: RunDetail) => void;
  onClose: () => void;
}) {
  const waiting = run.waiting.for === "escalation" ? run.waiting : null;
  const [choice, setChoice] = useState<Choice | null>(null);
  const [hint, setHint] = useState("");
  const [edited, setEdited] = useState<DocumentKind[]>([]);
  const [comments, setComments] = useState("");
  const [draftPr, setDraftPr] = useState(waiting?.openDraftPrOnAbort ?? true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!waiting) return null;

  const { title, why } = escalationTitle(
    waiting.trigger,
    waiting.slice,
    run.slices,
  );
  const slice = run.slices.find((one) => one.title === waiting.slice);
  const retries = slice ? retriesOf(slice.id, run.tasks) : null;
  const approved = run.documents.filter(
    (document) => document.status === "approved",
  );

  const resolution = ((): EscalationResolution | null => {
    switch (choice) {
      case "retryWithHint":
        return hint.trim() ? { choice, hint: hint.trim() } : null;
      case "editDocuments":
        return edited.length > 0 && comments.trim()
          ? {
              choice,
              edits: edited.map((documentKind) => ({
                documentKind,
                comments: comments.trim(),
              })),
            }
          : null;
      case "skipSlice":
        return { choice };
      case "abort":
        return { choice, openDraftPrOnAbort: draftPr };
      case null:
        return null;
    }
  })();

  const decide = async () => {
    if (!resolution) return;
    setSending(true);
    setError(null);
    try {
      onDecided(await api.resolveEscalation(run.id, resolution));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSending(false);
    }
  };

  return (
    <div className="overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="escalation-title"
      >
        <h2 id="escalation-title">
          {title}
          <span className="badge tone-red">{waiting.trigger}</span>
        </h2>
        <p className="muted">{why}</p>
        <div className="stats three">
          <div className="card stat">
            <span className="muted small">Trigger</span>
            <strong className="text-red">{triggerText(waiting.trigger)}</strong>
          </div>
          <div className="card stat">
            <span className="muted small">Retries used</span>
            <strong className="mono text-amber">
              {retries === null ? "—" : `${retries} / ${RETRY_BUDGET}`}
            </strong>
          </div>
          <div className="card stat">
            <span className="muted small">Tokens</span>
            <strong className="mono">
              {formatTokens(run.tokensUsed)} / {formatTokens(run.tokenBudget)}
            </strong>
          </div>
        </div>
        <p>{waiting.summary}</p>

        {waiting.reports.length > 0 && (
          <>
            <h3 className="eyebrow">
              {waiting.trigger === "loop" ? "Repeated issue" : "Issues"}
            </h3>
            <ul className="issues">
              {waiting.reports.map((report, index) => (
                <li key={index} className="card">
                  <span className="mono text-red">
                    {report.step} ›{" "}
                    {report.failingTest ?? report.endpoint ?? ""} →{" "}
                    {report.error}
                  </span>
                  <span className="faint small">
                    {[
                      report.file,
                      report.suspectedOwner &&
                        `suspected: ${ROLE_NAMES[report.suspectedOwner]}`,
                      report.occurrences > 1 &&
                        `${report.occurrences} failures`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {waiting.workingMemory.length > 0 && (
          <>
            <h3 className="eyebrow">Working memory</h3>
            {waiting.workingMemory.map((note) => (
              <div key={note.role} className="card memory">
                <strong>{ROLE_NAMES[note.role]}</strong>
                <p className="muted">{note.note}</p>
              </div>
            ))}
          </>
        )}

        <h3 className="eyebrow">Choose what happens next</h3>
        <div
          className="choices"
          role="radiogroup"
          aria-label="What happens next"
        >
          {CHOICES.map((option) => (
            <button
              key={option.choice}
              type="button"
              role="radio"
              aria-checked={choice === option.choice}
              className={option.choice === "abort" ? "danger" : ""}
              disabled={
                option.choice === "editDocuments" && approved.length === 0
              }
              onClick={() => setChoice(option.choice)}
            >
              <strong>{option.label}</strong>
              <span className="small muted">{option.note}</span>
            </button>
          ))}
        </div>

        {choice === "retryWithHint" && (
          <label className="field">
            Hint for the agents
            <textarea
              value={hint}
              onChange={(event) => setHint(event.target.value)}
              placeholder="What they are missing, e.g. the slot length is 30 minutes everywhere."
            />
          </label>
        )}
        {choice === "editDocuments" && (
          <fieldset className="edits">
            <legend className="small muted">Documents to change</legend>
            {approved.map((document) => (
              <label key={document.kind} className="check">
                <input
                  type="checkbox"
                  checked={edited.includes(document.kind)}
                  onChange={(event) =>
                    setEdited(
                      event.target.checked
                        ? [...edited, document.kind]
                        : edited.filter((kind) => kind !== document.kind),
                    )
                  }
                />
                {DOCUMENT_NAMES[document.kind]}
              </label>
            ))}
            <label className="field">
              What should change
              <textarea
                value={comments}
                onChange={(event) => setComments(event.target.value)}
              />
            </label>
          </fieldset>
        )}
        {choice === "abort" && (
          <label className="check draft-pr">
            <input
              type="checkbox"
              checked={draftPr}
              onChange={(event) => setDraftPr(event.target.checked)}
            />
            <span>
              Open a Draft PR with the passed slices
              <span className="small faint">
                {" "}
                Only Slices that passed a Test Run; the rest is discarded.
              </span>
            </span>
          </label>
        )}

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`button ${choice === "abort" ? "danger-fill" : "primary"}`}
            disabled={sending || resolution === null}
            onClick={decide}
          >
            {choice ? CONFIRM[choice] : "Choose one"}
          </button>
        </div>
      </div>
    </div>
  );
}
