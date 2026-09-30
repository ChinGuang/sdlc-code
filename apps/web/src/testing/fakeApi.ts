/**
 * A RunsApi for tests: Runs it is given, and an event stream a test pushes to,
 * as the server would.
 */
import type { RunsApi } from "../api/client.js";
import type { RunDetail, RunEvent, RunSummary } from "../api/types.js";

type Distribute<T> = T extends unknown
  ? Omit<T, "runId" | "seq" | "happenedAt">
  : never;
export type EventBody = Distribute<RunEvent>;

export function fakeApi(options: {
  runs?: RunSummary[];
  detail?: RunDetail;
  startRun?: RunsApi["startRun"];
}) {
  let detail = options.detail;
  const listeners = new Set<(event: RunEvent) => void>();
  const calls = { getRun: 0, followedFrom: [] as number[], closed: 0 };
  let seq = detail?.lastSeq ?? 0;

  const api: RunsApi = {
    listRuns: async () => options.runs ?? [],
    getRun: async () => {
      calls.getRun += 1;
      if (!detail) throw new Error("No Run.");
      return detail;
    },
    startRun:
      options.startRun ??
      (async () => {
        throw new Error("not in this test");
      }),
    serverUp: async () => true,
    followRun: (_runId, after, onEvent) => {
      calls.followedFrom.push(after);
      listeners.add(onEvent);
      return () => {
        calls.closed += 1;
        listeners.delete(onEvent);
      };
    },
  };

  /** Sends an event to every follower, numbered after the last one. */
  const push = (body: EventBody, at = "2026-09-29T10:00:00.000Z") => {
    seq += 1;
    const event = {
      ...body,
      runId: detail?.id ?? "run",
      seq,
      happenedAt: at,
    } as RunEvent;
    for (const listener of listeners) listener(event);
    return event;
  };

  /** Sends an event again, as a stream that reconnected would. */
  const resend = (event: RunEvent) => {
    for (const listener of listeners) listener(event);
  };

  /** What the server answers from now on, as a Run moves. */
  const setDetail = (next: RunDetail) => {
    detail = next;
  };

  return { api, push, resend, setDetail, calls };
}

export const SUMMARY: RunSummary = {
  id: "0a1b2c3d-0000-4000-8000-000000000001",
  projectRequest: "Todo app",
  mode: "gated",
  status: "building",
  tokensUsed: 612_000,
  tokenBudget: 2_000_000,
  pullRequest: null,
  createdAt: "2026-09-29T09:00:00.000Z",
  updatedAt: "2026-09-29T09:58:00.000Z",
};

export const DETAIL: RunDetail = {
  ...SUMMARY,
  slices: [
    {
      id: "s1",
      title: "Walking Skeleton",
      status: "passed",
      isWalkingSkeleton: true,
      commitSha: "a1b2c3d4e5f6",
    },
    {
      id: "s2",
      title: "Sign in",
      status: "building",
      isWalkingSkeleton: false,
      commitSha: null,
    },
    {
      id: "s3",
      title: "Todos",
      status: "pending",
      isWalkingSkeleton: false,
      commitSha: null,
    },
  ],
  documents: [],
  tasks: [
    {
      id: "t1",
      sliceId: "s2",
      role: "backendCoding",
      status: "running",
      retriesSpent: 1,
      steps: [
        {
          id: "st1",
          status: "completed",
          startedAt: "2026-09-29T09:50:00.000Z",
          endedAt: "2026-09-29T09:52:00.000Z",
        },
        {
          id: "st2",
          status: "running",
          startedAt: "2026-09-29T09:52:00.000Z",
          endedAt: null,
        },
      ],
    },
  ],
  waiting: { for: "nothing" },
  failure: null,
  advancing: true,
  lastSeq: 100,
};
