// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, type RunsApi } from "../api/client.js";
import type { RunMode, RunSummary } from "../api/types.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { runHref } from "../router.js";
import {
  formatTokens,
  progress,
  RETRY_BUDGET,
  shortId,
  timeAgo,
} from "../run/view.js";

/** How often the table asks again: Runs move on their own. */
const POLL_MS = 5000;

/** Board 01: start a Run, and see every Run. */
export function RunsPage({
  api,
  search,
  now = () => new Date(),
}: {
  api: RunsApi;
  search: string;
  now?: () => Date;
}) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      api.listRuns().then(
        (list) => {
          if (!live) return;
          setRuns(list);
          setLoadError(null);
        },
        (error: unknown) =>
          live &&
          setLoadError(error instanceof Error ? error.message : String(error)),
      );
    // The next ask waits for this answer, so a slow server never gets two
    // at once, nor an old answer after a new one.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () =>
      void load().finally(() => {
        if (live) timer = setTimeout(poll, POLL_MS);
      });
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api]);

  const query = search.trim().toLowerCase();
  const shown = (runs ?? []).filter(
    (run) =>
      !query ||
      run.projectRequest.toLowerCase().includes(query) ||
      run.id.toLowerCase().includes(query.replace(/^#/, "")),
  );

  return (
    <>
      <div>
        <h1>Runs</h1>
        <p className="muted" style={{ margin: "6px 0 0" }}>
          Turn a product request into a reviewed pull request.
        </p>
      </div>
      <NewRunForm api={api} />
      <section className="card" aria-label="Recent runs">
        <h2>Recent runs</h2>
        {loadError && <div className="error">{loadError}</div>}
        <div className="table-scroll">
          <table className="runs">
            <thead>
              <tr>
                <th>Run</th>
                <th>Request</th>
                <th>Progress</th>
                <th>Tokens</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {runs === null && !loadError ? (
                <tr>
                  <td colSpan={6} className="empty">
                    Loading…
                  </td>
                </tr>
              ) : shown.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">
                    {query
                      ? "No Run matches."
                      : "No Runs yet. Start one above."}
                  </td>
                </tr>
              ) : (
                shown.map((run) => (
                  <RunRow key={run.id} run={run} now={now()} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function RunRow({ run, now }: { run: RunSummary; now: Date }) {
  const { label, fraction } = progress(run);
  const open = () => {
    window.location.hash = runHref(run.id);
  };
  return (
    <tr className="row" onClick={open}>
      <td className="mono">
        <a href={runHref(run.id)}>{shortId(run.id)}</a>
      </td>
      <td>{run.projectRequest}</td>
      <td>
        <div className="progress">
          <div className="bar">
            <span style={{ width: `${fraction * 100}%` }} />
          </div>
          <span className="muted">{label}</span>
        </div>
      </td>
      <td className="mono muted">
        {formatTokens(run.tokensUsed)} / {formatTokens(run.tokenBudget)}
      </td>
      <td>
        <StatusBadge run={run} />
      </td>
      <td className="muted">{timeAgo(run.updatedAt, now)}</td>
    </tr>
  );
}

const DEFAULT_BUDGET = 2_000_000;

/** What a Run needs to start; the server checks it again, and says why not. */
function NewRunForm({ api }: { api: RunsApi }) {
  const [projectRequest, setProjectRequest] = useState("");
  const [targetRepo, setTargetRepo] = useState("");
  const [mode, setMode] = useState<RunMode>("gated");
  const [tokenBudget, setTokenBudget] = useState(
    DEFAULT_BUDGET.toLocaleString("en-US"),
  );
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<{
    message: string;
    problems: string[];
  } | null>(null);
  const request = useRef<HTMLTextAreaElement>(null);

  // The sidebar's "New run" link lands here, whether or not the page is new.
  useEffect(() => {
    const focus = () => {
      if (window.location.hash === "#new-run") request.current?.focus();
    };
    focus();
    window.addEventListener("hashchange", focus);
    return () => window.removeEventListener("hashchange", focus);
  }, []);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setStarting(true);
    setError(null);
    try {
      const run = await api.startRun({
        projectRequest: projectRequest.trim(),
        mode,
        tokenBudget: Number(tokenBudget.replace(/[,_\s]/g, "")),
        targetRepo: targetRepo.trim() || null,
      });
      window.location.hash = runHref(run.id);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? { message: caught.message, problems: caught.problems }
          : {
              message:
                caught instanceof Error ? caught.message : String(caught),
              problems: [],
            },
      );
      setStarting(false);
    }
  };

  return (
    <form className="card" id="new-run" aria-label="New run" onSubmit={start}>
      <h2>New run</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <label className="field">
          Project request
          <textarea
            ref={request}
            value={projectRequest}
            onChange={(event) => setProjectRequest(event.target.value)}
            placeholder="A todo app with sign-in, where each person sees only their own todos."
            required
          />
          <span className="hint">
            Stack profile: React + Node · Vitest (the only one so far)
          </span>
        </label>
        <div className="form-row">
          <label className="field">
            Target repo
            <input
              className="mono"
              value={targetRepo}
              onChange={(event) => setTargetRepo(event.target.value)}
              placeholder="owner/name — empty keeps it local"
            />
          </label>
          <div className="field" role="group" aria-labelledby="gates-label">
            <span id="gates-label">Gates</span>
            <div className="segmented">
              <button
                type="button"
                aria-pressed={mode === "gated"}
                onClick={() => setMode("gated")}
              >
                Gated · Design + PR
              </button>
              <button
                type="button"
                aria-pressed={mode === "auto"}
                onClick={() => setMode("auto")}
              >
                Auto · no gates
              </button>
            </div>
          </div>
          <label className="field">
            Token budget
            <input
              className="mono"
              inputMode="numeric"
              value={tokenBudget}
              onChange={(event) => setTokenBudget(event.target.value)}
            />
          </label>
          <label className="field">
            Retries / task
            <input className="mono" value={RETRY_BUDGET} readOnly disabled />
          </label>
          <button
            type="submit"
            className="button primary"
            disabled={starting || projectRequest.trim() === ""}
          >
            {starting ? "Starting…" : "Start run"}
          </button>
        </div>
        {error && (
          <div className="error" role="alert">
            {error.message}
            {error.problems.length > 0 && (
              <ul>
                {error.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
