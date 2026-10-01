/**
 * What the screens show for a Run, worked out from what the server says. Pure
 * functions, so every label and colour a person reads is decided in one place
 * and tested without rendering anything.
 */
import type {
  AgentRole,
  RunDetail,
  RunEvent,
  RunSlice,
  RunStatus,
  RunSummary,
  RunTask,
} from "../api/types.js";

/** CONTEXT.md "Retry Budget": the same for every Task, and for review send-backs. */
export const RETRY_BUDGET = 3;

/** The palette's meanings: each is a colour pair in styles.css. */
export type Tone = "green" | "blue" | "amber" | "red" | "purple" | "muted";

export type Badge = { label: string; tone: Tone };

export function statusBadge(
  run: Pick<RunSummary, "status" | "pullRequest"> &
    Partial<Pick<RunSummary, "waitingFor">>,
): Badge {
  // Still designing, but nothing moves until a person asks again (T24f).
  if (run.waitingFor === "designRetry")
    return { label: "Design failed", tone: "amber" };
  switch (run.status) {
    case "designing":
      return { label: "Designing", tone: "blue" };
    case "awaitingDesignGate":
      return { label: "Awaiting Design Gate", tone: "amber" };
    case "building":
      return { label: "Coding", tone: "blue" };
    case "reviewing":
      return { label: "Code Review", tone: "blue" };
    case "awaitingPrGate":
      return { label: "Awaiting PR Gate", tone: "purple" };
    case "escalated":
      return { label: "Escalated", tone: "red" };
    case "done":
      return run.pullRequest?.draft
        ? { label: "Draft PR", tone: "muted" }
        : { label: "Done", tone: "green" };
    case "failed":
      // In auto mode a Run that stops still opens a Draft PR of what passed.
      return run.pullRequest
        ? { label: "Failed · Draft PR", tone: "red" }
        : { label: "Failed", tone: "red" };
    case "aborted":
      return run.pullRequest
        ? { label: "Aborted · Draft PR", tone: "muted" }
        : { label: "Aborted", tone: "muted" };
  }
}

export type PhaseState =
  "done" | "current" | "upcoming" | "stopped" | "skipped";

export type Phase = { key: string; label: string; state: PhaseState };

const PHASES = ["design", "designGate", "slices", "review", "prGate"] as const;
type PhaseKey = (typeof PHASES)[number];

/** Where a Run is in its phases while it is moving. */
const PHASE_OF: Partial<Record<RunStatus, PhaseKey>> = {
  designing: "design",
  awaitingDesignGate: "designGate",
  building: "slices",
  reviewing: "review",
  awaitingPrGate: "prGate",
};

/**
 * The phase stepper: Design, Design Gate, Slices, Code Review, PR Gate. An
 * auto Run has no gates, so they are skipped rather than waited on; a Run that
 * stopped is marked where it stopped.
 */
export function phases(
  run: Pick<
    RunDetail,
    "status" | "mode" | "slices" | "pullRequest" | "failure"
  >,
): Phase[] {
  const at = run.status === "done" ? null : whereItIs(run);
  const atIndex = at === null ? PHASES.length : PHASES.indexOf(at);
  // A gated design that failed waits for a person: stopped, though designing.
  const stopped =
    ["escalated", "failed", "aborted"].includes(run.status) ||
    (run.status === "designing" && run.failure?.trigger === "design");
  return PHASES.map((key, index) => {
    const gate = key === "designGate" || key === "prGate";
    let state: PhaseState =
      index < atIndex ? "done" : index === atIndex ? "current" : "upcoming";
    if (state === "current" && stopped) state = "stopped";
    if (gate && run.mode === "auto" && state !== "stopped") state = "skipped";
    // Finished with nothing to deliver: no pull request, so no PR Gate held.
    if (key === "prGate" && run.status === "done" && !run.pullRequest)
      state = "skipped";
    return { key, label: phaseLabel(key, run.slices), state };
  });
}

/**
 * Where a Run is, or where it stopped. A stopped Run does not say, so its
 * Slices do: none started means it never got past design; all of them through
 * means it was being reviewed.
 */
function whereItIs(
  run: Pick<RunDetail, "status" | "slices" | "failure">,
): PhaseKey {
  const moving = PHASE_OF[run.status];
  if (moving) return moving;
  // The Slice Plan is saved during design, so Slices that exist but never
  // started say nothing about getting past it.
  if (
    run.failure?.trigger === "design" ||
    run.slices.every((slice) => slice.status === "pending")
  )
    return "design";
  return run.slices.every(isThrough) ? "review" : "slices";
}

function phaseLabel(key: PhaseKey, slices: RunSlice[]): string {
  switch (key) {
    case "design":
      return "Design";
    case "designGate":
      return "Design Gate";
    case "slices":
      return slices.length === 0
        ? "Slices"
        : `Slices ${slices.filter(isThrough).length}/${slices.length}`;
    case "review":
      return "Code Review";
    case "prGate":
      return "PR Gate";
  }
}

const isThrough = (slice: RunSlice) =>
  slice.status === "passed" || slice.status === "skipped";

/** The runs table's progress column: a phrase and how far along the bar is. */
export function progress(run: RunSummary): { label: string; fraction: number } {
  if (run.waitingFor === "designRetry")
    return { label: "Design failed", fraction: 0.1 };
  const pr = run.pullRequest ? `PR #${run.pullRequest.number}` : null;
  switch (run.status) {
    case "designing":
      return { label: "Design", fraction: 0.1 };
    case "awaitingDesignGate":
      return { label: "Design Gate", fraction: 0.25 };
    case "building":
      return { label: "Slices", fraction: 0.5 };
    case "reviewing":
      return { label: "Code Review", fraction: 0.75 };
    case "awaitingPrGate":
      return { label: pr ?? "PR Gate", fraction: 0.9 };
    case "done":
      return {
        label: run.pullRequest?.draft ? `Draft ${pr}` : (pr ?? "Done"),
        fraction: 1,
      };
    case "escalated":
      return { label: "Needs a person", fraction: 0.5 };
    case "failed":
      return { label: pr ? `Draft ${pr}` : "Failed", fraction: 0 };
    case "aborted":
      return { label: pr ? `Draft ${pr}` : "Aborted", fraction: 0 };
  }
}

export const ROLE_NAMES: Record<AgentRole, string> = {
  orchestrator: "Orchestrator",
  systemDesign: "System Design Agent",
  uiDesign: "UI Design Agent",
  backendCoding: "Backend Coding Agent",
  frontendCoding: "Frontend Coding Agent",
  testing: "Testing Agent",
  codeReview: "Code Review Agent",
};

/** A Slice's right-hand note: its Slice Commit, its retries, or what it waits for. */
export function sliceNote(slice: RunSlice, tasks: RunTask[]): Badge {
  const retries = retriesOf(slice.id, tasks);
  switch (slice.status) {
    case "passed":
      return { label: (slice.commitSha ?? "").slice(0, 7), tone: "green" };
    case "skipped":
      return { label: "Skipped", tone: "muted" };
    case "pending":
      return { label: "Pending", tone: "muted" };
    case "building":
    case "testing":
      return retries > 0
        ? { label: `Retry ${retries}/${RETRY_BUDGET}`, tone: "amber" }
        : {
            label: slice.status === "testing" ? "Testing" : "Building",
            tone: "blue",
          };
  }
}

/** The most of its Retry Budget any of this Slice's Tasks has spent. */
export function retriesOf(sliceId: string, tasks: RunTask[]): number {
  return Math.max(
    0,
    ...tasks
      .filter((task) => task.sliceId === sliceId)
      .map((task) => task.retriesSpent),
  );
}

/** The Slice being worked on, if any: the one a person is watching. */
export function currentSlice(slices: RunSlice[]): RunSlice | null {
  return (
    slices.find(
      (slice) => slice.status === "building" || slice.status === "testing",
    ) ?? null
  );
}

export type Lane = {
  role: "backendCoding" | "frontendCoding";
  name: string;
  status: string;
  tone: Tone;
  steps: number;
};

/** A Slice's two Coding Agents, side by side, as far as each has got. */
export function lanes(
  slice: RunSlice,
  tasks: RunTask[],
  runStatus: RunStatus,
): Lane[] {
  return (["backendCoding", "frontendCoding"] as const).map((role) => {
    // One Task per side per Slice, kept across its retries.
    const task = tasks.find(
      (one) => one.sliceId === slice.id && one.role === role,
    );
    return {
      role,
      name: ROLE_NAMES[role],
      ...laneStatus(task, slice, runStatus),
      steps:
        task?.steps.filter((step) => step.status === "completed").length ?? 0,
    };
  });
}

/**
 * What a lane is doing. A Task stays running from its first Step until the
 * Slice is settled, through Test Runs and Escalations, so only a running Step
 * means code is being written.
 */
function laneStatus(
  task: RunTask | undefined,
  slice: RunSlice,
  runStatus: RunStatus,
): { status: string; tone: Tone } {
  if (!task) return { status: "Not started", tone: "muted" };
  switch (task.status) {
    case "pending":
      return { status: "Waiting", tone: "muted" };
    case "done":
      return { status: "Done", tone: "green" };
    case "failed":
      return { status: "Failed", tone: "red" };
    case "running":
      if (task.steps.some((step) => step.status === "running"))
        return { status: "Writing code", tone: "blue" };
      if (runStatus === "escalated")
        return { status: "Waiting for a person", tone: "amber" };
      if (slice.status === "testing")
        return { status: "Waiting for the Test Run", tone: "muted" };
      return { status: "Between Steps", tone: "muted" };
  }
}

/** "612k", "2.0M": a budget read at a glance. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** "2m ago", measured from `now` so a test can hold the clock still. */
export function timeAgo(iso: string, now: Date): string {
  const seconds = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** A Run's short name: ids are UUIDs, and six characters tell them apart. */
export const shortId = (runId: string) => `#${runId.slice(0, 6)}`;

export type Activity = { who: string; what: string; tone: Tone };

/** One line of the Activity feed; null for what is not worth a line. */
export function describe(event: RunEvent, slices: RunSlice[]): Activity | null {
  const sliceName = (id: string | null) => {
    const index = slices.findIndex((slice) => slice.id === id);
    return index === -1 ? "a Slice" : `Slice ${index + 1}`;
  };
  switch (event.type) {
    case "status":
      return {
        who: "Orchestrator",
        what: `Run is now ${statusBadge({ status: event.status, pullRequest: null }).label}`,
        tone: statusBadge({ status: event.status, pullRequest: null }).tone,
      };
    case "step":
      if (event.phase === "completed") return null;
      return {
        who: ROLE_NAMES[event.role],
        what:
          event.phase === "started"
            ? event.sliceId
              ? `started a Step on ${sliceName(event.sliceId)}`
              : "started a Step"
            : "discarded a Step it could not finish",
        tone: event.phase === "started" ? "blue" : "amber",
      };
    case "tokens":
    case "agentTurn":
      return null;
    case "toolFailed":
      return {
        who: ROLE_NAMES[event.role],
        what: `${event.tool} failed: ${event.problem}`,
        tone: "amber",
      };
    case "checkpoint":
      return {
        who: "Orchestrator",
        what:
          event.at === "committed"
            ? `committed ${sliceName(event.sliceId)}`
            : event.at === "merged"
              ? `merged both lanes of ${sliceName(event.sliceId)}`
              : `sent ${sliceName(event.sliceId)} back to retry`,
        tone: event.at === "retrying" ? "amber" : "green",
      };
    case "testRun":
      return {
        who: "Testing Agent",
        what: `Test Run ${event.status}: ${event.summary}`,
        tone: event.status === "passed" ? "green" : "red",
      };
    case "exportFailed":
      return {
        who: "UI Design Agent",
        what: `could not export ${event.screen}: ${event.reason}`,
        tone: "amber",
      };
    case "reviewProblem":
      return { who: "Code Review Agent", what: event.problem, tone: "amber" };
    case "delivery":
      return {
        who: "Orchestrator",
        what:
          event.status === "opened"
            ? `opened ${event.detail}`
            : `kept the commits local: ${event.detail}`,
        tone: event.status === "opened" ? "green" : "muted",
      };
    case "problem":
      return { who: "Orchestrator", what: event.problem, tone: "red" };
  }
}

/** The last Test Run, if it found Issues: what the Issue card shows. */
export function openIssues(
  testRun: Extract<RunEvent, { type: "testRun" }> | null,
): Extract<RunEvent, { type: "testRun" }> | null {
  return testRun && testRun.status !== "passed" ? testRun : null;
}

const TRIGGERS: Record<string, string> = {
  design: "no valid design came out",
  retryBudget: "the Retry Budget is spent",
  tokenBudget: "the Token Budget is spent",
  loop: "the agents are going round in a loop",
  undecidableOwner: "no one could tell whose an Issue is",
};

/** Why a Run stopped for a person, in words. */
export const triggerText = (trigger: string) => TRIGGERS[trigger] ?? trigger;
