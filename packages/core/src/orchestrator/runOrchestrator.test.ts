/**
 * The Orchestrator end to end over a real database, the real Design Gate and
 * Design Phase, with scripted design agents and a scripted Slice runner:
 * Design Gate verdicts, Slices, and each Escalation choice.
 */
import { REACT_NODE } from "@sdlc-code/stack-profiles";
import { describe, expect, it } from "vitest";
import type { AgentLoopResult } from "../agentLoop/agentLoop.js";
import type { Design } from "../agents/systemDesign/design.js";
import { goodDesign } from "../agents/systemDesign/fixtures/goodDesign.js";
import type {
  SystemDesignAgent,
  SystemDesignInput,
} from "../agents/systemDesign/systemDesignAgent.js";
import { goodUiSpec } from "../agents/uiDesign/fixtures/goodUiSpec.js";
import type {
  UiDesignAgent,
  UiDesignInput,
} from "../agents/uiDesign/uiDesignAgent.js";
import {
  DOCUMENT_KINDS,
  type DocumentKind,
} from "../domain/documentLifecycle.js";
import type { RunMode } from "../domain/runLifecycle.js";
import { openDatabase } from "../persistence/database.js";
import { SqliteDocumentStore } from "../persistence/documentStore.js";
import { SqliteEscalationStore } from "../persistence/escalationStore.js";
import { SqliteGateStore } from "../persistence/gateStore.js";
import { SqliteRunStore } from "../persistence/runStore.js";
import { SqliteSliceStore } from "../persistence/sliceStore.js";
import { SqliteTaskStore } from "../persistence/taskStore.js";
import { DocumentDesignGate } from "./designGate.js";
import { AgentDesignPhase } from "./designPhase.js";
import { issueReport } from "./fixtures/issueReport.js";
import { BASELINE_RULES } from "@sdlc-code/stack-profiles";
import type { Finding } from "../agents/codeReview/findings.js";
import type {
  DeliveryOutcome,
  DeliveryReason,
  RunDelivery,
} from "../delivery/runDelivery.js";
import type { RunReview } from "./runReview.js";
import {
  AgentRunOrchestrator,
  type RunOrchestrator,
} from "./runOrchestrator.js";
import type {
  SliceCheckpoint,
  SliceHistory,
  SliceOutcome,
  SliceRunInput,
} from "./sliceRunner.js";

const loop: AgentLoopResult = {
  stopReason: "answered",
  answer: "Done.",
  workingMemory: "- done",
  iterations: 1,
  toolCalls: 1,
  failedToolCalls: 0,
  usage: { promptTokens: 1, completionTokens: 1 },
  error: null,
};

const HISTORY: SliceHistory = {
  earlier: { backend: [], frontend: [], design: [] },
  retryBaseline: {},
};

const approveAll = (kinds: readonly DocumentKind[] = DOCUMENT_KINDS) =>
  kinds.map((documentKind) => ({
    documentKind,
    decision: "approve" as const,
    comments: "",
  }));

function setup(options: {
  mode?: RunMode;
  /** What the Slice runner returns, call by call; passes when it runs out. */
  outcomes?: SliceOutcome[];
  /** The Slice Plan a revision of the System Design comes back with. */
  revisedPlan?: Design["slicePlan"];
  /** Design calls that fail (no valid design), by call number from 1. */
  failDesign?: number[];
  /** What delivering the pull request does; it opens one by default. */
  delivery?: DeliveryOutcome;
  /** What the review finds; without it a Run is delivered unreviewed. */
  review?: {
    linter?: Finding[];
    agent?: Finding[];
    unknownRuleIds?: string[];
    /** How the agent's Step ended; "answered" unless a test says otherwise. */
    stopReason?: AgentLoopResult["stopReason"];
  };
  /** Called per review: true once the Findings are meant to be gone. */
  reviewsClean?: () => boolean;
  /** How often blocking Findings may send the code back. */
  reviewRetryBudget?: number;
  /**
   * The process dies inside the first Slice, between two attempts, with this
   * as what the Slice had failed on so far.
   */
  killAfterRetry?: SliceHistory;
}) {
  const db = openDatabase(":memory:");
  const store = { db };
  const runs = new SqliteRunStore(store);
  const documents = new SqliteDocumentStore(store);
  const slices = new SqliteSliceStore(store);
  const tasks = new SqliteTaskStore(store);
  const escalations = new SqliteEscalationStore(store);
  const gates = new SqliteGateStore(store);
  const gate = new DocumentDesignGate({ db, runs, documents, gates });
  const run = runs.createRun({
    projectRequest: "Build a todo app",
    mode: options.mode ?? "gated",
    targetRepo: {
      owner: "o",
      name: "r",
      baseBranch: "main",
      runBranch: "sdlc/todo",
    },
    stackProfile: "react-node",
    tokenBudget: 1_000_000,
  });

  const designCalls: SystemDesignInput[] = [];
  const uiCalls: UiDesignInput[] = [];
  const systemDesign: SystemDesignAgent = {
    design: async (input) => {
      designCalls.push(input);
      if (options.failDesign?.includes(designCalls.length))
        return {
          design: null,
          loop: { ...loop, workingMemory: "- mermaid kept failing" },
        };
      const design: Design = goodDesign();
      if (input.revision && options.revisedPlan)
        design.slicePlan = options.revisedPlan;
      // A revision changes the Contract's title, so it is a new version.
      if (input.revision)
        (design.apiContract.info as { title: string }).title =
          `Todo API r${designCalls.length}`;
      return { design, loop };
    },
  };
  const uiDesign: UiDesignAgent = {
    design: async (input) => {
      uiCalls.push(input);
      const spec = goodUiSpec();
      if (input.revision) spec.tokens.accent = "#DC2626";
      return {
        spec,
        screens: spec.screens.map((screen, index) => ({
          name: screen.name,
          boardId: `board-${index}`,
          export: { bytes: Buffer.from(screen.name), mimeType: "image/png" },
        })),
        page: {
          name: "#1",
          pageId: "page-1",
          fileId: "file-1",
          removedBoards: [],
        },
        loop,
      };
    },
  };

  const deliveries: Array<{ runId: string; reason: DeliveryReason }> = [];
  const delivery: RunDelivery = {
    deliver: async (runId, reason) => {
      deliveries.push({ runId, reason });
      const outcome: DeliveryOutcome = options.delivery ?? {
        status: "opened",
        pullRequest: {
          number: 7,
          url: "https://github.com/o/r/pull/7",
          draft: reason.ended !== "complete",
          branch: "sdlc/todo",
        },
      };
      // The real delivery records the pull request on the Run; so must this.
      if (outcome.status === "opened")
        runs.setPullRequest(runId, {
          number: outcome.pullRequest.number,
          url: outcome.pullRequest.url,
          draft: outcome.pullRequest.draft,
        });
      return outcome;
    },
  };

  const reviews: Array<{ runId: string; standard: number }> = [];
  const codeReview: RunReview | undefined = options.review && {
    reviewRun: async (run) => {
      reviews.push({ runId: run.id, standard: BASELINE_RULES.length });
      const clean = options.reviewsClean?.() ?? false;
      return {
        findings: clean
          ? []
          : [
              ...(options.review?.linter ?? []),
              ...(options.review?.agent ?? []),
            ],
        stopReason: options.review?.stopReason ?? "answered",
        problems: (options.review?.unknownRuleIds ?? []).map(
          (id) => `The Code Review Agent cited ${id}, which nobody has.`,
        ),
      };
    },
  };
  const reviewProblems: Array<[string, string]> = [];

  const runnerCalls: SliceRunInput[] = [];
  const sliceCheckpoints: Array<(checkpoint: SliceCheckpoint) => void> = [];
  const outcomes = [...(options.outcomes ?? [])];
  // Tests depend on the interface; only this factory knows the class. A second
  // one over the same stores is a restarted process (see "resuming a Run").
  const build = (): RunOrchestrator =>
    new AgentRunOrchestrator({
      runs,
      documents,
      slices,
      tasks,
      escalations,
      gates,
      gate,
      delivery,
      codeReview,
      onReviewProblem: (runId, problem) =>
        reviewProblems.push([runId, problem]),
      reviewRetryBudget: options.reviewRetryBudget,
      designPhase: () =>
        new AgentDesignPhase({
          documents,
          slices,
          gate,
          systemDesign,
          uiDesign,
          profile: () => REACT_NODE,
          pageName: () => "#1 Todo",
        }),
      sliceRunner: async (_run, onCheckpoint) => ({
        runSlice: async (input) => {
          runnerCalls.push(input);
          // The real runner reports each Checkpoint of diagram 6; a test says
          // which ones happened through `sliceCheckpoint` below.
          sliceCheckpoints.push(onCheckpoint);
          if (options.killAfterRetry && runnerCalls.length === 1) {
            slices.moveSlice(input.slice.id, "building");
            onCheckpoint({
              at: "retrying",
              sliceId: input.slice.id,
              attempt: 2,
              history: options.killAfterRetry,
            });
            throw new Error("the process died mid-Slice");
          }
          const outcome = outcomes.shift() ?? {
            status: "passed",
            commit: `commit-${runnerCalls.length}`,
            attempts: 1,
          };
          // Moves the Slice the way the real runner does, from wherever it is.
          const now = () =>
            slices.listSlices(input.runId).find((s) => s.id === input.slice.id)!
              .status;
          if (now() === "pending") slices.moveSlice(input.slice.id, "building");
          if (outcome.status === "passed") {
            slices.moveSlice(input.slice.id, "testing");
            slices.moveSlice(input.slice.id, "passed", outcome.commit);
          }
          return outcome;
        },
      }),
      profile: () => REACT_NODE,
      capabilities: {
        backend: { vision: false, penpotMcp: false },
        frontend: { vision: true, penpotMcp: false },
      },
      penpotPage: () => "#1 Todo",
    });
  const orchestrator = build();
  const status = () => runs.getRun(run.id)!.status;
  const sliceStatuses = () =>
    slices.listSlices(run.id).map((slice) => [slice.title, slice.status]);
  return {
    orchestrator,
    restart: build,
    gates,
    deliveries,
    reviews,
    reviewProblems,
    /** Reports a Checkpoint from inside a Slice, as the real runner does. */
    sliceCheckpoint: (checkpoint: SliceCheckpoint) =>
      sliceCheckpoints.at(-1)!(checkpoint),
    runId: run.id,
    status,
    sliceStatuses,
    designCalls,
    uiCalls,
    runnerCalls,
    documents,
    escalations,
    tasks,
    slices,
    runs,
  };
}

/** A gated Run with its design approved, building its Slices. */
async function approved(options: Parameters<typeof setup>[0]) {
  const context = setup(options);
  await context.orchestrator.advance(context.runId);
  context.orchestrator.decideDesign(context.runId, approveAll());
  return context;
}

const escalatedWith = (
  trigger: "retryBudget" | "loop" = "retryBudget",
): SliceOutcome => ({
  status: "escalated",
  trigger,
  summary: "Still failing after 3 retries: TodoList > empty state",
  reports: [issueReport()],
  history: HISTORY,
});

describe("AgentRunOrchestrator: the review before the pull request (T19)", () => {
  const finding = (overrides: Partial<Finding> = {}): Finding => ({
    ruleId: "CLEAN-01",
    file: "src/App.tsx",
    line: 4,
    message: "`d` says nothing about what it holds.",
    severity: "minor",
    source: "codeReview",
    ...overrides,
  });

  it("reviews the code, then opens the pull request with what it found", async () => {
    const context = await approved({
      review: {
        linter: [finding({ ruleId: "LINT-02", source: "linter" })],
        agent: [finding()],
      },
    });

    await context.orchestrator.advance(context.runId);

    expect(context.reviews).toEqual([
      { runId: context.runId, standard: BASELINE_RULES.length },
    ]);
    expect(context.deliveries).toEqual([
      {
        runId: context.runId,
        reason: {
          ended: "complete",
          findings: [
            {
              ruleId: "LINT-02",
              location: "src/App.tsx:4",
              message: "`d` says nothing about what it holds.",
            },
            {
              ruleId: "CLEAN-01",
              location: "src/App.tsx:4",
              message: "`d` says nothing about what it holds.",
            },
          ],
        },
      },
    ]);
    expect(context.status()).toBe("awaitingPrGate");
  });

  it("sends a blocking Finding back to the Slice, and pushes nothing", async () => {
    const context = await approved({
      review: {
        agent: [
          finding({
            ruleId: "SEC-01",
            severity: "blocking",
            message: "The API key is in the source.",
          }),
        ],
      },
      reviewRetryBudget: 1,
    });
    await context.orchestrator.advance(context.runId);

    // The last Slice was built again, told which Rule it broke and where.
    const again = context.runnerCalls.at(-1);
    expect(again?.slice.title).toBe("Todos");
    expect(again?.hint).toEqual({
      from: "codeReview",
      issues: [
        {
          summary:
            "SEC-01 (blocking) in src/App.tsx:4: The API key is in the source.",
          evidence: "The API key is in the source.",
        },
      ],
    });
    // Nothing reaches the Target Repo while the review refuses it.
    expect(context.deliveries).toEqual([]);
  });

  // Otherwise a review that keeps refusing the same code rebuilds the last
  // Slice for ever, which is what this test found the first time it ran.
  it("stops sending the code back once the Retry Budget is spent", async () => {
    const context = setup({
      mode: "auto",
      review: {
        agent: [finding({ ruleId: "SEC-01", severity: "blocking" })],
      },
      reviewRetryBudget: 2,
    });

    await expect(context.orchestrator.advance(context.runId)).resolves.toEqual({
      finished: "failed",
    });

    expect(context.reviews).toHaveLength(3);
    expect(context.runs.getRun(context.runId)?.failure).toMatchObject({
      trigger: "retryBudget",
      summary: expect.stringContaining("still refuses the code after 2"),
    });
    // A Draft PR of the Slices that did pass, as any auto-mode failure gets.
    expect(context.deliveries).toEqual([
      { runId: context.runId, reason: { ended: "failed", openDraftPr: true } },
    ]);
  });

  it("a person decides at an Escalation when the review will not pass", async () => {
    const context = await approved({
      review: {
        agent: [finding({ ruleId: "SEC-01", severity: "blocking" })],
      },
      reviewRetryBudget: 1,
    });

    const progress = await context.orchestrator.advance(context.runId);

    expect(progress).toMatchObject({ waitingFor: "escalation" });
    expect(context.escalations.getOpenEscalation(context.runId)?.trigger).toBe(
      "retryBudget",
    );
  });

  it("counts the send-backs in the Checkpoint, so a restart cannot reset them", async () => {
    const context = await approved({
      review: {
        agent: [finding({ ruleId: "SEC-01", severity: "blocking" })],
      },
      reviewRetryBudget: 1,
    });

    await context.orchestrator.advance(context.runId);

    expect(context.runs.latestCheckpoint(context.runId)?.payload).toMatchObject(
      { reviewRetries: 1 },
    );
  });

  it("delivers unreviewed when no review is configured, and says nothing about it", async () => {
    const context = await approved({});

    await context.orchestrator.advance(context.runId);

    expect(context.reviews).toEqual([]);
    expect(context.deliveries).toEqual([
      { runId: context.runId, reason: { ended: "complete", findings: [] } },
    ]);
  });

  // The path a Run is meant to take: the review refuses it, the Slice is fixed,
  // the second review is clean and the pull request opens.
  it("opens the pull request once a second review comes back clean", async () => {
    let reviewed = 0;
    const context = setup({
      mode: "auto",
      review: { agent: [finding({ ruleId: "SEC-01", severity: "blocking" })] },
      reviewsClean: () => ++reviewed > 1,
    });

    await expect(context.orchestrator.advance(context.runId)).resolves.toEqual({
      finished: "done",
    });

    expect(context.reviews).toHaveLength(2);
    expect(context.deliveries).toEqual([
      { runId: context.runId, reason: { ended: "complete", findings: [] } },
    ]);
  });

  // A review that stopped early read part of the diff, so its silence says
  // nothing; opening a pull request on it is the one thing this step prevents.
  it("does not deliver on a review that ran out of Token Budget", async () => {
    const context = setup({
      mode: "auto",
      review: { stopReason: "tokenBudget" },
    });

    await expect(context.orchestrator.advance(context.runId)).resolves.toEqual({
      finished: "failed",
    });

    expect(context.runs.getRun(context.runId)?.failure).toMatchObject({
      trigger: "tokenBudget",
      summary: expect.stringContaining("did not finish"),
    });
    // Only the Draft PR of what passed, never the reviewed-looking one.
    expect(context.deliveries).toEqual([
      { runId: context.runId, reason: { ended: "failed", openDraftPr: true } },
    ]);
  });

  it("does not deliver on a review that ran out of turns either", async () => {
    const context = await approved({ review: { stopReason: "maxIterations" } });

    const progress = await context.orchestrator.advance(context.runId);

    expect(progress).toMatchObject({ waitingFor: "escalation" });
    expect(context.deliveries).toEqual([]);
  });

  it("says so when the review cited a Rule nobody has", async () => {
    const context = await approved({
      review: { unknownRuleIds: ["VIBES-01"] },
    });

    await context.orchestrator.advance(context.runId);

    expect(context.reviewProblems).toEqual([
      [context.runId, expect.stringContaining("VIBES-01")],
    ]);
    expect(context.status()).toBe("awaitingPrGate");
  });
});

describe("AgentRunOrchestrator: the PR Gate (T20)", () => {
  /** A gated Run with every Slice built, waiting at the PR Gate. */
  async function atPrGate() {
    const context = await approved({});
    await context.orchestrator.advance(context.runId);
    return context;
  }

  it("opens the pull request, then waits for a person at the PR Gate", async () => {
    const { runId, status, gates, deliveries, runs } = await atPrGate();

    expect(status()).toBe("awaitingPrGate");
    expect(gates.getOpenGate(runId)?.kind).toBe("pr");
    expect(deliveries).toEqual([
      { runId, reason: { ended: "complete", findings: [] } },
    ]);
    expect(runs.getRun(runId)?.pullRequest).toMatchObject({ draft: false });
  });

  it("approve: the Run is done and the Gate records it", async () => {
    const context = await atPrGate();
    const gateId = context.gates.getOpenGate(context.runId)!.id;

    context.orchestrator.decidePullRequest(context.runId, {
      choice: "approve",
    });

    expect(context.status()).toBe("done");
    expect(context.gates.getOpenGate(context.runId)).toBeNull();
    expect(
      context.gates.listVerdicts(gateId).map((verdict) => verdict.decision),
    ).toEqual(["approve"]);
    await expect(context.orchestrator.advance(context.runId)).resolves.toEqual({
      finished: "done",
    });
  });

  it("request changes: the last Slice is built again with the comments", async () => {
    const context = await atPrGate();

    context.orchestrator.decidePullRequest(context.runId, {
      choice: "requestChanges",
      comments: "The delete button needs a confirmation.",
    });

    expect(context.status()).toBe("building");
    expect(context.sliceStatuses()).toEqual([
      ["Walking Skeleton", "passed"],
      ["Todos", "building"],
    ]);

    await context.orchestrator.advance(context.runId);

    expect(context.runnerCalls.at(-1)?.hint).toEqual({
      from: "person",
      issues: [
        {
          summary: "The delete button needs a confirmation.",
          evidence: "The delete button needs a confirmation.",
        },
      ],
    });
  });

  it("refuses a decision with nothing to change, and one with no Gate", async () => {
    const context = await atPrGate();

    expect(() =>
      context.orchestrator.decidePullRequest(context.runId, {
        choice: "requestChanges",
        comments: "  ",
      }),
    ).toThrow(/Say what to change/);
    expect(context.status()).toBe("awaitingPrGate");

    context.orchestrator.decidePullRequest(context.runId, {
      choice: "approve",
    });
    expect(() =>
      context.orchestrator.decidePullRequest(context.runId, {
        choice: "approve",
      }),
    ).toThrow(/no open PR Gate/);
  });

  // Every Slice skipped: the plan finished, but there is no code to push.
  it("finishes without a pull request when there is no Slice Commit", async () => {
    const context = await approved({
      delivery: { status: "keptLocal", reason: "noSliceCommit" },
    });

    const progress = await context.orchestrator.advance(context.runId);

    expect(progress).toEqual({ finished: "done" });
    expect(context.gates.getOpenGate(context.runId)).toBeNull();
    expect(context.runs.getRun(context.runId)?.pullRequest).toBeNull();
  });
});

describe("AgentRunOrchestrator: the Draft PR of a Run that stopped (T20)", () => {
  it("offers the passed Slices when a person aborts with the checkbox ticked", async () => {
    const context = await approved({ outcomes: [escalatedWith()] });
    await context.orchestrator.advance(context.runId);

    context.orchestrator.resolveEscalation(context.runId, { choice: "abort" });
    await expect(context.orchestrator.advance(context.runId)).resolves.toEqual({
      finished: "aborted",
    });

    expect(context.deliveries).toEqual([
      { runId: context.runId, reason: { ended: "aborted", openDraftPr: true } },
    ]);
  });

  it("pushes nothing when the person unticks the checkbox", async () => {
    const context = await approved({ outcomes: [escalatedWith()] });
    await context.orchestrator.advance(context.runId);
    context.orchestrator.resolveEscalation(context.runId, {
      choice: "abort",
      openDraftPrOnAbort: false,
    });
    await context.orchestrator.advance(context.runId);

    expect(context.deliveries).toEqual([
      {
        runId: context.runId,
        reason: { ended: "aborted", openDraftPr: false },
      },
    ]);
  });

  it("always offers a Draft PR when an auto-mode Run fails", async () => {
    const context = setup({ mode: "auto", outcomes: [escalatedWith()] });

    await expect(context.orchestrator.advance(context.runId)).resolves.toEqual({
      finished: "failed",
    });

    expect(context.deliveries).toEqual([
      { runId: context.runId, reason: { ended: "failed", openDraftPr: true } },
    ]);
  });

  it("delivers once, however often advance is called afterwards", async () => {
    const context = setup({ mode: "auto", outcomes: [escalatedWith()] });
    await context.orchestrator.advance(context.runId);

    await context.orchestrator.advance(context.runId);

    expect(context.deliveries).toHaveLength(1);
  });
});

describe("AgentRunOrchestrator: resuming a Run (T18)", () => {
  // The Run stops mid-build: a spent budget, a closed laptop, a kill -9.
  it("a restarted process takes the same next action", async () => {
    const context = await approved({ outcomes: [escalatedWith()] });
    await context.orchestrator.advance(context.runId);
    expect(context.status()).toBe("escalated");
    const before = context.sliceStatuses();

    // Nothing of the first orchestrator survives, only what it wrote down.
    const resumed = context.restart();
    const progress = await resumed.advance(context.runId);

    expect(progress).toMatchObject({ waitingFor: "escalation" });
    expect(context.sliceStatuses()).toEqual(before);
  });

  // The plan's own test: killed mid-Slice, a resumed Run must not hand the
  // Slice a fresh Retry Budget and forget what it already failed on.
  it("keeps what a Slice failed on when the process dies between attempts", async () => {
    const history: SliceHistory = {
      earlier: { backend: [issueReport()], frontend: [], design: [] },
      retryBaseline: { backend: 1 },
    };
    const context = await approved({ killAfterRetry: history });
    await expect(context.orchestrator.advance(context.runId)).rejects.toThrow(
      /died mid-Slice/,
    );

    const resumed = context.restart();
    await resumed.advance(context.runId);

    // Without the Checkpoint the Slice would start over with a full Retry
    // Budget and no memory of the failure it already had.
    const sliceId = context.runnerCalls[0]!.slice.id;
    expect(
      context.runnerCalls.slice(1).find((call) => call.slice.id === sliceId)
        ?.history,
    ).toEqual(history);
  });

  it("gives a resumed Slice what it already failed on, from the Checkpoint", async () => {
    const failed: SliceOutcome = {
      status: "escalated",
      trigger: "retryBudget",
      summary: "Still failing",
      reports: [issueReport()],
      history: {
        earlier: { backend: [issueReport()], frontend: [], design: [] },
        retryBaseline: { backend: 2 },
      },
    };
    const context = await approved({ outcomes: [failed] });
    await context.orchestrator.advance(context.runId);

    // A person retries with a hint, then the process restarts.
    context.orchestrator.resolveEscalation(context.runId, {
      choice: "retryWithHint",
      hint: "Validate the title before saving it.",
    });
    const resumed = context.restart();
    await resumed.advance(context.runId);

    // The retry of the Slice that failed, not whatever ran after it.
    const first = context.runnerCalls[0]!.slice.id;
    const retry = context.runnerCalls
      .slice(1)
      .find((call) => call.slice.id === first)!;
    expect(retry.hint).toEqual({
      from: "person",
      issues: [
        {
          summary: "Validate the title before saving it.",
          evidence: "Validate the title before saving it.",
        },
      ],
    });
    expect(retry.history).toEqual(failed.history);
  });

  it("keeps a person's document edits when the process restarts", async () => {
    const context = await approved({ outcomes: [escalatedWith()] });
    await context.orchestrator.advance(context.runId);
    context.orchestrator.resolveEscalation(context.runId, {
      choice: "editDocuments",
      edits: [
        { documentKind: "apiContract", comments: "POST /todos needs a 400." },
      ],
    });

    const resumed = context.restart();
    await resumed.advance(context.runId);

    // The revision the person asked for reached the agent that owns it.
    expect(context.designCalls.at(-1)?.revision?.comments).toContain(
      "POST /todos needs a 400.",
    );
  });

  it("ignores a Checkpoint it cannot read, and builds the Slice again", async () => {
    const context = await approved({ outcomes: [escalatedWith()] });
    await context.orchestrator.advance(context.runId);
    context.runs.saveCheckpoint(context.runId, { version: 99 });

    const resumed = context.restart();
    await resumed.advance(context.runId);

    expect(context.status()).toBe("escalated");
  });
});

describe("AgentRunOrchestrator: design", () => {
  it("designs, saves the Slice Plan, and waits at the Design Gate", async () => {
    const { orchestrator, runId, status, sliceStatuses, documents } = setup({});

    const progress = await orchestrator.advance(runId);

    expect(progress).toEqual({ waitingFor: "designGate" });
    expect(status()).toBe("awaitingDesignGate");
    expect(sliceStatuses()).toEqual([
      ["Walking Skeleton", "pending"],
      ["Todos", "pending"],
    ]);
    expect(
      DOCUMENT_KINDS.map((kind) => documents.getLatest(runId, kind)?.status),
    ).toEqual(Array(5).fill("inReview"));
  });

  it("builds every Slice once the design is approved, then waits for review", async () => {
    const { orchestrator, runId, status, runnerCalls, sliceStatuses } =
      await approved({});

    const progress = await orchestrator.advance(runId);

    expect(progress).toEqual({
      waitingFor: "prGate",
      pullRequest: {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        draft: false,
      },
    });
    expect(status()).toBe("awaitingPrGate");
    expect(runnerCalls.map((call) => call.plan.title)).toEqual([
      "Walking Skeleton",
      "Todos",
    ]);
    expect(sliceStatuses().map(([, s]) => s)).toEqual(["passed", "passed"]);
    // The UI Design Agent's exports reach the Coding Agents (for vision).
    expect([...runnerCalls[1]!.screenImages.keys()]).toEqual([
      "Health",
      "Todo list",
    ]);
  });

  it("sends changes back to the owning agent with the comments, and re-opens the Gate for them only", async () => {
    const { orchestrator, runId, status, designCalls, uiCalls, documents } =
      setup({});
    await orchestrator.advance(runId);

    orchestrator.decideDesign(runId, [
      ...approveAll(["systemDesign", "slicePlan", "uiSpec", "penpotDesign"]),
      {
        documentKind: "apiContract",
        decision: "requestChanges",
        comments: "Add DELETE /todos/{id}.",
      },
    ]);
    const progress = await orchestrator.advance(runId);

    expect(progress).toEqual({ waitingFor: "designGate" });
    expect(designCalls[1]!.revision?.comments).toEqual([
      "Add DELETE /todos/{id}.",
    ]);
    // The UI documents built on the old Contract are redone too.
    expect(uiCalls).toHaveLength(2);
    expect(documents.getLatest(runId, "apiContract")).toMatchObject({
      version: 2,
      status: "inReview",
    });
    // Unchanged Approved Documents keep their Verdict.
    expect(documents.getLatest(runId, "systemDesign")?.status).toBe("approved");
    expect(status()).toBe("awaitingDesignGate");
  });

  it("goes from Project Request to a pull request with no one asked in auto mode", async () => {
    const { orchestrator, runId, status, runs, deliveries } = setup({
      mode: "auto",
    });

    // No Design Gate and no PR Gate: the pull request is the Run's result.
    await expect(orchestrator.advance(runId)).resolves.toEqual({
      finished: "done",
    });
    expect(status()).toBe("done");
    expect(deliveries).toEqual([
      { runId, reason: { ended: "complete", findings: [] } },
    ]);
    expect(runs.getRun(runId)?.pullRequest).toMatchObject({
      number: 7,
      draft: false,
    });
  });
});

describe("AgentRunOrchestrator: Escalations", () => {
  it("stops at an Escalation when a Slice hits a limit", async () => {
    const { orchestrator, runId, status } = await approved({
      outcomes: [
        { status: "passed", commit: "c1", attempts: 1 },
        escalatedWith(),
      ],
    });

    const progress = await orchestrator.advance(runId);

    expect(progress).toMatchObject({
      waitingFor: "escalation",
      escalation: {
        trigger: "retryBudget",
        summary: "Still failing after 3 retries: TodoList > empty state",
      },
    });
    expect(status()).toBe("escalated");
  });

  it("retry with hint: builds the Slice again with the hint and its history", async () => {
    const { orchestrator, runId, runnerCalls } = await approved({
      outcomes: [
        { status: "passed", commit: "c1", attempts: 1 },
        escalatedWith(),
      ],
    });
    await orchestrator.advance(runId);

    orchestrator.resolveEscalation(runId, {
      choice: "retryWithHint",
      hint: "Render the empty state before the fetch resolves.",
    });
    const progress = await orchestrator.advance(runId);

    expect(progress).toEqual({
      waitingFor: "prGate",
      pullRequest: {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        draft: false,
      },
    });
    expect(runnerCalls.at(-1)).toMatchObject({
      plan: { title: "Todos" },
      hint: {
        from: "person",
        issues: [
          { evidence: "Render the empty state before the fetch resolves." },
        ],
      },
      history: HISTORY,
    });
  });

  it("skip Slice: marks it skipped, fails its Tasks, and builds on", async () => {
    const { orchestrator, runId, sliceStatuses, tasks, slices } =
      await approved({
        outcomes: [escalatedWith()],
      });
    await orchestrator.advance(runId);
    const skeleton = slices.listSlices(runId)[0]!;
    const task = tasks.createTask({
      runId,
      sliceId: skeleton.id,
      agentRole: "frontendCoding",
    });
    tasks.setTaskStatus(task.id, "running");

    orchestrator.resolveEscalation(runId, { choice: "skipSlice" });
    const progress = await orchestrator.advance(runId);

    expect(progress).toEqual({
      waitingFor: "prGate",
      pullRequest: {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        draft: false,
      },
    });
    expect(sliceStatuses()).toEqual([
      ["Walking Skeleton", "skipped"],
      ["Todos", "passed"],
    ]);
    expect(tasks.listTasks(runId)[0]!.status).toBe("failed");
  });

  it("edit documents: the owning agent revises them and the Gate re-opens", async () => {
    const { orchestrator, runId, status, uiCalls } = await approved({
      outcomes: [escalatedWith()],
    });
    await orchestrator.advance(runId);

    orchestrator.resolveEscalation(runId, {
      choice: "editDocuments",
      edits: [
        { documentKind: "uiSpec", comments: "Show an empty state." },
        { documentKind: "systemDesign", comments: "  " },
      ],
    });
    expect(status()).toBe("designing");
    const progress = await orchestrator.advance(runId);

    expect(progress).toEqual({ waitingFor: "designGate" });
    expect(uiCalls.at(-1)!.revision?.comments).toEqual([
      "Show an empty state.",
    ]);
  });

  it("abort: the Run ends, and a Draft PR is asked for by default", async () => {
    const { orchestrator, runId, escalations } = await approved({
      outcomes: [escalatedWith()],
    });
    await orchestrator.advance(runId);

    orchestrator.resolveEscalation(runId, { choice: "abort" });

    await expect(orchestrator.advance(runId)).resolves.toEqual({
      finished: "aborted",
    });
    expect(escalations.listEscalations(runId)[0]).toMatchObject({
      choice: "abort",
      openDraftPrOnAbort: true,
    });
  });

  it("changes nothing when a resolution is missing what it needs", async () => {
    const { orchestrator, runId, status, escalations } = await approved({
      outcomes: [escalatedWith()],
    });
    await orchestrator.advance(runId);

    expect(() =>
      orchestrator.resolveEscalation(runId, {
        choice: "retryWithHint",
        hint: " ",
      }),
    ).toThrow(/needs a hint/);
    expect(() =>
      orchestrator.resolveEscalation(runId, {
        choice: "editDocuments",
        edits: [],
      }),
    ).toThrow(/at least one document/);
    expect(status()).toBe("escalated");
    expect(escalations.getOpenEscalation(runId)).not.toBeNull();
  });

  it("fails the Run instead in auto mode, keeping a failure report for the Draft PR", async () => {
    const { orchestrator, runId, runs, escalations } = setup({
      mode: "auto",
      outcomes: [escalatedWith("loop")],
    });

    const progress = await orchestrator.advance(runId);

    expect(progress).toEqual({ finished: "failed" });
    expect(escalations.listEscalations(runId)).toEqual([]);
    expect(runs.getRun(runId)!.failure).toMatchObject({
      trigger: "loop",
      slice: "Walking Skeleton",
    });
  });
});

describe("AgentRunOrchestrator: a Slice finds a design problem", () => {
  it("revises the document, re-opens the Gate, then builds the Slice again with its history", async () => {
    const report = issueReport({
      failingTest: "DELETE /todos/{id} > removes a todo",
      endpoint: "DELETE /todos/{id}",
      error: "404",
    });
    const { orchestrator, runId, status, uiCalls, runnerCalls } =
      await approved({
        outcomes: [
          { status: "passed", commit: "c1", attempts: 1 },
          {
            status: "designIssue",
            revisions: [{ owner: "uiDesign", reports: [report] }],
            history: HISTORY,
          },
        ],
      });

    const progress = await orchestrator.advance(runId);

    expect(progress).toEqual({ waitingFor: "designGate" });
    expect(status()).toBe("awaitingDesignGate");
    expect(uiCalls.at(-1)!.revision?.comments).toEqual([
      "DELETE /todos/{id} > removes a todo: 404",
    ]);

    // The Penpot page and boards are the same, so only the UI Spec is judged.
    orchestrator.decideDesign(runId, approveAll(["uiSpec"]));
    await expect(orchestrator.advance(runId)).resolves.toEqual({
      waitingFor: "prGate",
      pullRequest: {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        draft: false,
      },
    });
    expect(runnerCalls.at(-1)).toMatchObject({
      plan: { title: "Todos" },
      history: HISTORY,
    });
  });
});

// Scenarios from the T17c review, each broken in the first version.
describe("AgentRunOrchestrator: revisions that touch several documents", () => {
  it("revises both the API Contract and the UI Spec when a Slice blames both", async () => {
    const { orchestrator, runId, status, designCalls, uiCalls } =
      await approved({
        outcomes: [
          { status: "passed", commit: "c1", attempts: 1 },
          {
            status: "designIssue",
            revisions: [
              {
                owner: "systemDesign",
                reports: [issueReport({ error: "no DELETE" })],
              },
              {
                owner: "uiDesign",
                reports: [issueReport({ error: "no delete button" })],
              },
            ],
            history: HISTORY,
          },
        ],
      });

    await expect(orchestrator.advance(runId)).resolves.toEqual({
      waitingFor: "designGate",
    });
    expect(status()).toBe("awaitingDesignGate");
    expect(designCalls.at(-1)!.revision?.comments[0]).toContain("no DELETE");
    expect(uiCalls.at(-1)!.revision?.comments[0]).toContain("no delete button");
  });

  it("edits several documents at once, merging repeated ones", async () => {
    const { orchestrator, runId, designCalls, uiCalls } = await approved({
      outcomes: [escalatedWith()],
    });
    await orchestrator.advance(runId);

    orchestrator.resolveEscalation(runId, {
      choice: "editDocuments",
      edits: [
        { documentKind: "apiContract", comments: "Add DELETE /todos/{id}." },
        { documentKind: "uiSpec", comments: "Add a delete button." },
        { documentKind: "apiContract", comments: "Return 204." },
      ],
    });
    await expect(orchestrator.advance(runId)).resolves.toEqual({
      waitingFor: "designGate",
    });

    expect(designCalls.at(-1)!.revision?.comments).toEqual([
      "Add DELETE /todos/{id}.\nReturn 204.",
    ]);
    expect(uiCalls.at(-1)!.revision?.comments).toEqual([
      "Add a delete button.",
    ]);
  });

  it("refuses to edit the Penpot design, changing nothing", async () => {
    const { orchestrator, runId, status } = await approved({
      outcomes: [escalatedWith()],
    });
    await orchestrator.advance(runId);

    expect(() =>
      orchestrator.resolveEscalation(runId, {
        choice: "editDocuments",
        edits: [
          { documentKind: "uiSpec", comments: "Bigger buttons." },
          { documentKind: "penpotDesign", comments: "Move the logo." },
        ],
      }),
    ).toThrow(/Edit the UI Spec instead/);
    expect(status()).toBe("escalated");
  });

  it("only asks the UI Design Agent when only the UI Spec is sent back", async () => {
    const { orchestrator, runId, designCalls, uiCalls } = setup({});
    await orchestrator.advance(runId);

    orchestrator.decideDesign(runId, [
      ...approveAll([
        "systemDesign",
        "slicePlan",
        "apiContract",
        "penpotDesign",
      ]),
      {
        documentKind: "uiSpec",
        decision: "requestChanges",
        comments: "Darker.",
      },
    ]);
    await orchestrator.advance(runId);

    expect(designCalls).toHaveLength(1);
    expect(uiCalls).toHaveLength(2);
  });
});

describe("AgentRunOrchestrator: a revised Slice Plan", () => {
  it("asks about a started Slice the plan dropped, then builds the plan's new one", async () => {
    const { orchestrator, runId, sliceStatuses, runnerCalls, documents } =
      await approved({
        revisedPlan: [
          goodDesign().slicePlan[0]!,
          { ...goodDesign().slicePlan[1]!, title: "Todo list" },
        ],
        outcomes: [
          { status: "passed", commit: "c1", attempts: 1 },
          {
            status: "designIssue",
            revisions: [{ owner: "systemDesign", reports: [issueReport()] }],
            history: HISTORY,
          },
        ],
      });
    await orchestrator.advance(runId);
    // Approve whatever the Gate re-opened for.
    const inReview = DOCUMENT_KINDS.filter(
      (kind) => documents.getLatest(runId, kind)?.status === "inReview",
    );
    orchestrator.decideDesign(runId, approveAll(inReview));

    // "Todos" had started, so it keeps its record, and a person decides.
    await expect(orchestrator.advance(runId)).resolves.toMatchObject({
      waitingFor: "escalation",
      escalation: {
        summary: expect.stringContaining(
          '"Todos" is no longer in the Slice Plan',
        ),
      },
    });

    orchestrator.resolveEscalation(runId, { choice: "skipSlice" });
    await expect(orchestrator.advance(runId)).resolves.toEqual({
      waitingFor: "prGate",
      pullRequest: {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        draft: false,
      },
    });
    expect(sliceStatuses()).toEqual([
      ["Walking Skeleton", "passed"],
      ["Todos", "skipped"],
      ["Todo list", "passed"],
    ]);
    expect(runnerCalls.at(-1)!.plan.title).toBe("Todo list");
  });
});

describe("AgentRunOrchestrator: a design agent fails", () => {
  it("fails the Run in auto mode, saying why", async () => {
    const { orchestrator, runId, runs } = setup({
      mode: "auto",
      failDesign: [1],
    });

    await expect(orchestrator.advance(runId)).resolves.toEqual({
      finished: "failed",
    });
    expect(runs.getRun(runId)!.failure).toMatchObject({
      trigger: "design",
      slice: null,
      summary: expect.stringContaining("mermaid kept failing"),
    });
  });

  it("waits in designing with a person, and tries again with the same revisions", async () => {
    const { orchestrator, runId, status, designCalls } = setup({
      failDesign: [2],
    });
    await orchestrator.advance(runId);
    orchestrator.decideDesign(runId, [
      ...approveAll(["systemDesign", "slicePlan", "uiSpec", "penpotDesign"]),
      {
        documentKind: "apiContract",
        decision: "requestChanges",
        comments: "Add paging.",
      },
    ]);

    await expect(orchestrator.advance(runId)).rejects.toThrow(
      /no valid design/,
    );
    expect(status()).toBe("designing");

    await expect(orchestrator.advance(runId)).resolves.toEqual({
      waitingFor: "designGate",
    });
    expect(designCalls.at(-1)!.revision?.comments).toEqual(["Add paging."]);
  });
});
