/**
 * The Run Overview kept live by its event stream: status and tokens change as
 * their events arrive, the Activity feed grows, Issues appear and clear, and
 * the Slice lanes are read again after a burst of Step events.
 */
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunDetail } from "../api/types.js";
import { DETAIL, fakeApi } from "../testing/fakeApi.js";
import { RunPage } from "./RunPage.js";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

async function open(detail = DETAIL) {
  const fake = fakeApi({ detail });
  const view = render(
    <RunPage api={fake.api} runId={detail.id} refreshDelayMs={50} />,
  );
  await screen.findByRole("heading", { name: detail.projectRequest });
  return { ...fake, ...view };
}

describe("RunPage: the Run as it is read", () => {
  it("shows the stepper, the Slice plan with its lanes, and the budget", async () => {
    await open();

    expect(screen.getByText("Coding · Slice 2")).toBeInTheDocument();
    expect(screen.getByText("Slices 1/3")).toBeInTheDocument();
    const current = screen.getByRole("listitem", { name: "Slice 2: Sign in" });
    expect(within(current).getByText("Retry 1/3")).toBeInTheDocument();
    const backend = within(current).getByLabelText("Backend Coding Agent");
    expect(within(backend).getByText("Writing code")).toBeInTheDocument();
    expect(within(backend).getByText("1 Step done")).toBeInTheDocument();
    expect(
      within(within(current).getByLabelText("Frontend Coding Agent")).getByText(
        "Not started",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("a1b2c3d")).toBeInTheDocument();
    expect(screen.getByTestId("tokens")).toHaveTextContent("612k / 2.0M");
  });

  it("follows the stream from the first event the server still has", async () => {
    const { calls } = await open();

    expect(calls.followedFrom).toEqual([0]);
  });

  it("stops following when the page closes", async () => {
    const { calls, unmount } = await open();

    unmount();

    expect(calls.closed).toBe(1);
  });
});

describe("RunPage: live from the stream", () => {
  it("moves its status badge and stepper as status events arrive", async () => {
    const { push } = await open();

    act(() => void push({ type: "status", status: "reviewing" }));

    expect(
      screen.getByText("Code Review", { selector: ".badge" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Code Review", { selector: "li span" }).closest("li"),
    ).toHaveAttribute("data-state", "current");
  });

  it("fills the budget bar as tokens are spent", async () => {
    const { push } = await open();

    act(
      () => void push({ type: "tokens", used: 1_500_000, budget: 2_000_000 }),
    );

    expect(screen.getByTestId("tokens")).toHaveTextContent("1.5M / 2.0M");
    expect(
      screen.getByRole("progressbar", { name: "Tokens spent" }),
    ).toHaveAttribute("aria-valuenow", "1500000");
  });

  it("adds what each agent does to the Activity feed, newest first", async () => {
    const { push } = await open();

    act(() => {
      push({
        type: "step",
        phase: "started",
        stepId: "st2",
        taskId: "t2",
        role: "frontendCoding",
        sliceId: "s2",
      });
      push({ type: "checkpoint", at: "merged", sliceId: "s2" });
    });

    const feed = within(screen.getByRole("region", { name: "Activity" }));
    const lines = feed.getAllByRole("listitem").map((line) => line.textContent);
    expect(lines[0]).toContain("merged both lanes of Slice 2");
    expect(lines[1]).toContain(
      "Frontend Coding Agent started a Step on Slice 2",
    );
  });

  // A reconnect can send again what was already received.
  it("shows an event sent twice only once", async () => {
    const { push, resend } = await open();

    act(() => {
      const event = push({ type: "problem", problem: "Sandbox quota reached" });
      resend(event);
    });

    const feed = within(screen.getByRole("region", { name: "Activity" }));
    expect(feed.getAllByText("Sandbox quota reached")).toHaveLength(1);
  });

  it("shows the Issues of a failed Test Run, and clears them when it passes", async () => {
    const { push } = await open();

    act(
      () =>
        void push({
          type: "testRun",
          status: "failed",
          summary: "ok install, FAILED smoke",
          durationSeconds: 42,
          cost: 0.01,
          issues: ["smoke › POST /api/auth/login → 400 Bad Request"],
        }),
    );

    const issues = screen.getByRole("region", { name: "Issues" });
    expect(within(issues).getByText("1 Issue")).toBeInTheDocument();
    expect(
      within(issues).getByText(
        "smoke › POST /api/auth/login → 400 Bad Request",
      ),
    ).toBeInTheDocument();

    act(
      () =>
        void push({
          type: "testRun",
          status: "passed",
          summary: "ok install, ok smoke",
          durationSeconds: 40,
          cost: 0.01,
          issues: [],
        }),
    );

    expect(screen.queryByRole("region", { name: "Issues" })).toBeNull();
  });

  // A model call sends an agentTurn and a tokens event, neither shown.
  it("keeps the Issues however many model calls follow them", async () => {
    const { push } = await open();

    act(() => {
      push({
        type: "testRun",
        status: "failed",
        summary: "FAILED smoke",
        durationSeconds: 1,
        cost: null,
        issues: ["smoke failed"],
      });
      for (let i = 0; i < 300; i += 1) {
        push({ type: "agentTurn", role: "backendCoding", toolCalls: ["edit"] });
        push({ type: "tokens", used: 700_000 + i, budget: 2_000_000 });
      }
    });

    expect(screen.getByText("smoke failed")).toBeInTheDocument();
    expect(
      screen.getByText(/Test Run failed: FAILED smoke/),
    ).toBeInTheDocument();
  });

  it("reads the Run again once after a burst of Step events", async () => {
    const { push, calls, setDetail } = await open();
    const before = calls.getRun;
    setDetail({
      ...DETAIL,
      tasks: [
        ...DETAIL.tasks,
        {
          id: "t2",
          sliceId: "s2",
          role: "frontendCoding",
          status: "running",
          retriesSpent: 0,
          steps: [
            {
              id: "x0",
              status: "running",
              startedAt: "2026-09-29T10:00:00.000Z",
              endedAt: null,
            },
          ],
        },
      ],
      lastSeq: 105,
    });

    act(() => {
      for (let i = 0; i < 5; i += 1)
        push({
          type: "step",
          phase: "started",
          stepId: `x${i}`,
          taskId: "t2",
          role: "frontendCoding",
          sliceId: "s2",
        });
    });
    await act(() => vi.advanceTimersByTimeAsync(60));

    expect(calls.getRun).toBe(before + 1);
    const frontend = screen.getByLabelText("Frontend Coding Agent");
    expect(within(frontend).getByText("Writing code")).toBeInTheDocument();
  });

  // The feed replays what happened before the page opened; the Run's own
  // fields must not go back in time with it.
  it("does not let an old event undo what the Run was read as", async () => {
    const fake = fakeApi({ detail: { ...DETAIL, lastSeq: 500 } });
    render(<RunPage api={fake.api} runId={DETAIL.id} refreshDelayMs={50} />);
    await screen.findByRole("heading", { name: DETAIL.projectRequest });

    // Older than the read's lastSeq of 500.
    act(() =>
      fake.resend({
        runId: DETAIL.id,
        seq: 101,
        happenedAt: "2026-09-29T09:00:00.000Z",
        type: "status",
        status: "designing",
      }),
    );

    expect(screen.getByText("Coding · Slice 2")).toBeInTheDocument();
    expect(screen.getByText(/Run is now Designing/)).toBeInTheDocument();
  });
});

describe("RunPage: reads and events that cross", () => {
  /** A fake whose reads answer only when a test says so. */
  function withHeldReads() {
    const fake = fakeApi({ detail: DETAIL });
    const answers: Array<(detail: RunDetail) => void> = [];
    fake.api.getRun = () =>
      new Promise<RunDetail>((resolve) => answers.push(resolve));
    return { ...fake, answers };
  }

  it("keeps a tokens event that arrived before the first read", async () => {
    const { api, answers, resend } = withHeldReads();
    render(<RunPage api={api} runId={DETAIL.id} refreshDelayMs={50} />);

    act(() =>
      resend({
        runId: DETAIL.id,
        seq: 101,
        happenedAt: "2026-09-29T10:00:00.000Z",
        type: "tokens",
        used: 700_000,
        budget: 2_000_000,
      }),
    );
    await act(async () => answers[0]!({ ...DETAIL, lastSeq: 100 }));

    expect(screen.getByTestId("tokens")).toHaveTextContent("700k / 2.0M");
  });

  it("does not let a read that left earlier undo a later one", async () => {
    const { api, answers, resend } = withHeldReads();
    render(<RunPage api={api} runId={DETAIL.id} refreshDelayMs={50} />);
    await act(async () => answers[0]!(DETAIL));

    // A Step starts, so the page reads again, and a status event follows.
    act(() =>
      resend({
        runId: DETAIL.id,
        seq: 101,
        happenedAt: "2026-09-29T10:00:00.000Z",
        type: "status",
        status: "reviewing",
      }),
    );
    // The earlier read, sent before the status moved, answers last.
    await act(async () => answers.at(-1)!({ ...DETAIL, lastSeq: 100 }));

    expect(
      screen.getByText("Code Review", { selector: ".badge" }),
    ).toBeInTheDocument();
  });
});

describe("RunPage: a Run that needs a person or stopped", () => {
  it("says it waits at the Design Gate", async () => {
    await open({
      ...DETAIL,
      status: "awaitingDesignGate",
      slices: [],
      tasks: [],
      waiting: {
        for: "designGate",
        documents: [
          { kind: "systemDesign", version: 1 },
          { kind: "slicePlan", version: 1 },
        ],
      },
    });

    expect(
      screen.getByText("Waiting for you at the Design Gate."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("2 documents to approve or send back."),
    ).toBeInTheDocument();
  });

  it("says why it escalated, in words", async () => {
    await open({
      ...DETAIL,
      status: "escalated",
      waiting: {
        for: "escalation",
        trigger: "retryBudget",
        summary: "Slice 2 failed its Test Run three times.",
        openDraftPrOnAbort: true,
      },
    });

    expect(
      screen.getByText("Escalated: the Retry Budget is spent."),
    ).toBeInTheDocument();
  });

  it("names a Run it cannot find", async () => {
    const { api } = fakeApi({});
    render(<RunPage api={api} runId="missing" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("No Run.");
  });
});
