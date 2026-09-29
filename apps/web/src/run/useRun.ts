/**
 * One Run, kept live: read once, then followed on its event stream. Status and
 * tokens change in place as their events arrive; what an event only hints at
 * (a Step began, a Slice was committed) is read again from the server, a moment
 * later, so one burst of events costs one request.
 */
import { useEffect, useReducer } from "react";
import type { RunsApi } from "../api/client.js";
import type { RunDetail, RunEvent } from "../api/types.js";

export type RunState = {
  detail: RunDetail | null;
  /** Oldest first, each once. */
  events: RunEvent[];
  error: string | null;
};

type Action =
  | { type: "loaded"; detail: RunDetail }
  | { type: "event"; event: RunEvent }
  | { type: "failed"; error: string };

export const initialRunState: RunState = {
  detail: null,
  events: [],
  error: null,
};

/** How many events the feed keeps; a long Run has thousands. */
const KEEP = 200;

export function runReducer(state: RunState, action: Action): RunState {
  switch (action.type) {
    case "loaded":
      return { ...state, detail: action.detail, error: null };
    case "failed":
      return { ...state, error: action.error };
    case "event": {
      const { event } = action;
      // A reconnect can send again what was already received.
      if (state.events.some((seen) => seen.seq === event.seq)) return state;
      const events = [...state.events, event]
        .sort((a, b) => a.seq - b.seq)
        .slice(-KEEP);
      return { ...state, events, detail: applyToDetail(state.detail, event) };
    }
  }
}

/** What an event changes on the Run itself, if it is newer than the read. */
function applyToDetail(
  detail: RunDetail | null,
  event: RunEvent,
): RunDetail | null {
  if (!detail || event.seq <= detail.lastSeq) return detail;
  switch (event.type) {
    case "status":
      return { ...detail, status: event.status, lastSeq: event.seq };
    case "tokens":
      return {
        ...detail,
        tokensUsed: event.used,
        tokenBudget: event.budget,
        lastSeq: event.seq,
      };
    default:
      return detail;
  }
}

/** Events after which the Run's Slices, Tasks or waiting have changed. */
const CHANGES_DETAIL = new Set<RunEvent["type"]>([
  "status",
  "step",
  "checkpoint",
  "testRun",
  "delivery",
]);

export type UseRunOptions = {
  /** How long to gather events before reading the Run again. */
  refreshDelayMs?: number;
};

export function useRun(
  api: RunsApi,
  runId: string,
  { refreshDelayMs = 400 }: UseRunOptions = {},
): RunState {
  const [state, dispatch] = useReducer(runReducer, initialRunState);

  useEffect(() => {
    let live = true;
    let refresh: ReturnType<typeof setTimeout> | null = null;
    const read = () =>
      api.getRun(runId).then(
        (detail) => live && dispatch({ type: "loaded", detail }),
        (error: unknown) =>
          live &&
          dispatch({
            type: "failed",
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    const readSoon = () => {
      refresh ??= setTimeout(() => {
        refresh = null;
        void read();
      }, refreshDelayMs);
    };
    void read();
    // From the first event the server still has, so the feed shows what
    // happened before the page was opened; the reducer keeps the Run's own
    // fields from going back in time.
    const stop = api.followRun(runId, 0, (event) => {
      if (!live) return;
      dispatch({ type: "event", event });
      if (CHANGES_DETAIL.has(event.type)) readSoon();
    });
    return () => {
      live = false;
      if (refresh) clearTimeout(refresh);
      stop();
    };
  }, [api, runId, refreshDelayMs]);

  return state;
}
