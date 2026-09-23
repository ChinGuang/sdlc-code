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
import {
  AgentRunOrchestrator,
  type RunOrchestrator,
} from "./runOrchestrator.js";
import type {
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
}) {
  const db = openDatabase(":memory:");
  const store = { db };
  const runs = new SqliteRunStore(store);
  const documents = new SqliteDocumentStore(store);
  const slices = new SqliteSliceStore(store);
  const tasks = new SqliteTaskStore(store);
  const escalations = new SqliteEscalationStore(store);
  const gate = new DocumentDesignGate({
    db,
    runs,
    documents,
    gates: new SqliteGateStore(store),
  });
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

  const runnerCalls: SliceRunInput[] = [];
  const outcomes = [...(options.outcomes ?? [])];
  // Tests depend on the interface; only this factory knows the class.
  const orchestrator: RunOrchestrator = new AgentRunOrchestrator({
    runs,
    documents,
    slices,
    tasks,
    escalations,
    gate,
    designPhase: new AgentDesignPhase({
      documents,
      slices,
      gate,
      systemDesign,
      uiDesign,
      profile: () => REACT_NODE,
      pageName: () => "#1 Todo",
    }),
    sliceRunner: async () => ({
      runSlice: async (input) => {
        runnerCalls.push(input);
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
  const status = () => runs.getRun(run.id)!.status;
  const sliceStatuses = () =>
    slices.listSlices(run.id).map((slice) => [slice.title, slice.status]);
  return {
    orchestrator,
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

    expect(progress).toEqual({ waitingFor: "codeReview" });
    expect(status()).toBe("reviewing");
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

  it("goes from Project Request to review with no one asked in auto mode", async () => {
    const { orchestrator, runId, status } = setup({ mode: "auto" });

    await expect(orchestrator.advance(runId)).resolves.toEqual({
      waitingFor: "codeReview",
    });
    expect(status()).toBe("reviewing");
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

    expect(progress).toEqual({ waitingFor: "codeReview" });
    expect(runnerCalls.at(-1)).toMatchObject({
      plan: { title: "Todos" },
      hint: "Render the empty state before the fetch resolves.",
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

    expect(progress).toEqual({ waitingFor: "codeReview" });
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
      waitingFor: "codeReview",
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
      waitingFor: "codeReview",
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
