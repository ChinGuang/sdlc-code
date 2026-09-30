import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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
  const dialog = useRef<HTMLDivElement>(null);

  // A modal dialog takes the focus while it is open and gives it back after,
  // so a keyboard never ends up behind it.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => before?.focus();
  }, []);

  if (!waiting) return null;

  const { title, why } = escalationTitle(
    waiting.trigger,
    waiting.slice,
    run.slices,
  );
  const unused = run.documents.some(
    (document) =>
      document.kind === "penpotDesign" && document.status === "approved",
  );
  const slice = run.slices.find((one) => one.title === waiting.slice);
  const retries = slice ? retriesOf(slice.id, run.tasks) : null;
  // The Penpot design is redrawn from the UI Spec, so that is what a person edits.
  const approved = run.documents.filter(
    (document) =>
      document.status === "approved" && document.kind !== "penpotDesign",
  );
  // Stopped in review, not in a Slice: there is no Slice to skip, and a retry
  // runs the review again with its attempts back.
  const inReview = waiting.slice === null;

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
        ref={dialog}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="escalation-title"
        tabIndex={-1}
        onKeyDown={(event) => keepFocus(event, onClose)}
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
        <fieldset className="choices">
          <legend className="sr-only">What happens next</legend>
          {CHOICES.map((option) => {
            const unavailable =
              (option.choice === "editDocuments" && approved.length === 0) ||
              (option.choice === "skipSlice" && inReview);
            const note = unavailable
              ? option.choice === "skipSlice"
                ? "No Slice is being built"
                : "No approved documents to edit"
              : option.choice === "retryWithHint" && inReview
                ? "Run the review again with its attempts back"
                : option.note;
            return (
              <label
                key={option.choice}
                className={`choice${option.choice === "abort" ? " danger" : ""}`}
              >
                <input
                  type="radio"
                  name="escalation-choice"
                  value={option.choice}
                  checked={choice === option.choice}
                  disabled={unavailable}
                  onChange={() => setChoice(option.choice)}
                />
                <strong>{option.label}</strong>
                <span className="small muted">{note}</span>
              </label>
            );
          })}
        </fieldset>

        {choice === "retryWithHint" && (
          <label className="field">
            {inReview ? "Why you are trying again" : "Hint for the agents"}
            <textarea
              value={hint}
              onChange={(event) => setHint(event.target.value)}
              placeholder="What they are missing, e.g. the slot length is 30 minutes everywhere."
            />
          </label>
        )}
        {choice === "editDocuments" && (
          <fieldset className="edits">
            <legend className="small muted">
              Documents to change
              {unused && " (edit the UI Spec to change the Penpot design)"}
            </legend>
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

/**
 * Escape puts the dialog aside; Tab and Shift+Tab go round inside it rather
 * than on to the page it covers.
 */
function keepFocus(event: KeyboardEvent<HTMLDivElement>, onClose: () => void) {
  if (event.key === "Escape") {
    event.stopPropagation();
    onClose();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), textarea:not(:disabled)",
    ),
  ];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
