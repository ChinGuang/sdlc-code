/**
 * The Slice runner against real git Workspaces and a real database, with
 * scripted Coding and Testing Agents: pass, retry, Loop, budgets, Owners.
 */
import { REACT_NODE, templateFiles } from "@sdlc-code/stack-profiles";
import type { CodingSide } from "@sdlc-code/stack-profiles";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentLoopResult } from "../agentLoop/agentLoop.js";
import type { CodingAgent, CodingInput } from "../agents/coding/codingAgent.js";
import { goodDesign } from "../agents/systemDesign/fixtures/goodDesign.js";
import type { IssueReport } from "../agents/testing/issueReports.js";
import type {
  TestingAgent,
  TestSliceResult,
} from "../agents/testing/testingAgent.js";
import { goodUiSpec } from "../agents/uiDesign/fixtures/goodUiSpec.js";
import { SqliteSliceStore } from "../persistence/sliceStore.js";
import { SqliteTaskStore } from "../persistence/taskStore.js";
import { databaseWithRun } from "../persistence/testDatabase.js";
import { GitWorkspaceManager } from "../workspaces/workspaceManager.js";
import { issueReport } from "./fixtures/issueReport.js";
import { RuleOwnerResolver } from "./ownerResolution.js";
import {
  OrchestratedSliceRunner,
  type SliceRunInput,
  type SliceRunner,
} from "./sliceRunner.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

const design = goodDesign();
const TODOS = design.slicePlan[1]!;

const loop = (answer = "Done."): AgentLoopResult => ({
  stopReason: "answered",
  answer,
  workingMemory: `- worked on it`,
  iterations: 2,
  toolCalls: 1,
  failedToolCalls: 0,
  usage: { promptTokens: 100, completionTokens: 10 },
  error: null,
});

const passing = (): TestSliceResult => ({
  passed: true,
  issueReports: [],
  testRun: {
    status: "passed",
    result: { profile: "react-node", passed: true, steps: [], durationMs: 1 },
    evidence: {
      operationId: "op",
      exitCode: 0,
      timedOut: false,
      durationSeconds: 1,
      cost: 0,
      log: "",
      changedFiles: [],
      removedFiles: [],
      withheldFiles: [],
    },
  },
});

const failing = (...reports: IssueReport[]): TestSliceResult => {
  const run = passing().testRun;
  if (run.status === "broken") throw new Error("unexpected");
  return {
    passed: false,
    issueReports: reports,
    testRun: {
      ...run,
      status: "failed",
      result: { ...run.result, passed: false },
    },
  };
};

const frontendFailure = (signature: string) =>
  issueReport({
    signature,
    failingTest: `TodoList > ${signature}`,
    file: "src/TodoList.test.tsx",
    endpoint: null,
    suspectedOwner: "frontendCoding",
  });

async function setup(options: {
  results: TestSliceResult[];
  tokens?: number;
  plan?: typeof TODOS;
}) {
  const root = mkdtempSync(join(tmpdir(), "sdlc-slice-"));
  folders.push(root);
  const { runId, options: store } = databaseWithRun();
  const tasks = new SqliteTaskStore(store);
  const slices = new SqliteSliceStore(store);
  const [, slice] = slices.saveSlices(runId, [
    { title: "Walking Skeleton", isWalkingSkeleton: true },
    { title: (options.plan ?? TODOS).title, isWalkingSkeleton: false },
  ]);
  const workspaces = new GitWorkspaceManager({
    repoDir: join(root, "run.git"),
    runBranch: "sdlc/todo-app",
    workspacesDir: join(root, "workspaces"),
  });
  await workspaces.startRun({
    scaffold: templateFiles(REACT_NODE),
    message: "Scaffold",
  });

  const calls: Array<{
    side: CodingSide;
    issues: string[];
    notes: string | null;
  }> = [];
  let tokens = options.tokens ?? 1_000_000;
  const results = [...options.results];
  const testing: TestingAgent = {
    testSlice: async () => {
      const next = results.shift();
      if (!next) throw new Error("tested more often than scripted");
      return next;
    },
  };
  const codingAgent = (side: CodingSide): CodingAgent => ({
    code: async (input: CodingInput) => {
      calls.push({
        side,
        issues: input.issueReports.map((issue) => issue.summary),
        notes: input.workingMemory,
      });
      tokens -= 1000;
      // Each attempt changes the side's own file, as a real fix would.
      const path = side === "backend" ? "server/todos.ts" : "src/TodoList.tsx";
      const file = join(input.workspaceDir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `// attempt ${calls.length}\n`);
      return {
        summary: `${side} done`,
        problem: null,
        changes: [{ path, kind: "written" }],
        loop: loop(),
      };
    },
  });
  // Tests depend on the interface; only this factory knows the class.
  const runner: SliceRunner = new OrchestratedSliceRunner({
    workspaces,
    testing,
    owners: new RuleOwnerResolver(),
    tasks,
    slices,
    budget: {
      remaining: () => tokens,
      spend: (spent) => void (tokens -= spent),
    },
    codingAgent,
  });
  const input = (overrides: Partial<SliceRunInput> = {}): SliceRunInput => ({
    runId,
    slice: slice!,
    plan: options.plan ?? TODOS,
    profile: REACT_NODE,
    projectRequest: "A todo app",
    documents: {
      systemDesign: "# System Design",
      slicePlan: design.slicePlan,
      apiContract: design.apiContract,
      uiSpec: goodUiSpec(),
    },
    capabilities: {
      backend: { vision: false, penpotMcp: false },
      frontend: { vision: false, penpotMcp: false },
    },
    screenImages: new Map(),
    penpotPage: null,
    ...overrides,
  });
  const sliceStatus = () =>
    slices.listSlices(runId).find((s) => s.id === slice!.id)!;
  return { runner, input, calls, tasks, runId, workspaces, sliceStatus };
}

describe("OrchestratedSliceRunner", () => {
  it("builds both sides, tests the merge, and commits the Slice", async () => {
    const { runner, input, calls, tasks, runId, workspaces, sliceStatus } =
      await setup({ results: [passing()] });

    const outcome = await runner.runSlice(input());

    expect(outcome).toMatchObject({ status: "passed", attempts: 1 });
    expect(calls.map((call) => call.side).sort()).toEqual([
      "backend",
      "frontend",
    ]);
    expect(sliceStatus()).toMatchObject({ status: "passed" });
    expect(await workspaces.sliceCommits()).toHaveLength(1);
    expect(
      tasks.listTasks(runId).map((task) => [task.agentRole, task.status]),
    ).toEqual([
      ["backendCoding", "done"],
      ["frontendCoding", "done"],
    ]);
  });

  it("retries only the side that owns the failure, with its Issue Report and notes", async () => {
    const { runner, input, calls, tasks, runId } = await setup({
      results: [failing(frontendFailure("empty state")), passing()],
    });

    const outcome = await runner.runSlice(input());

    expect(outcome).toMatchObject({ status: "passed", attempts: 2 });
    expect(calls.map((call) => call.side).slice(2)).toEqual(["frontend"]);
    expect(calls[2]).toMatchObject({
      issues: [expect.stringContaining("TodoList > empty state")],
      notes: "- worked on it",
    });
    expect(
      tasks.listTasks(runId).find((t) => t.agentRole === "frontendCoding")
        ?.retries,
    ).toBe(1);
  });

  it("escalates a Loop at once, without spending the Retry Budget", async () => {
    const { runner, input, sliceStatus } = await setup({
      results: [
        failing(frontendFailure("empty state")),
        failing(frontendFailure("empty state")),
      ],
    });

    const outcome = await runner.runSlice(input());

    expect(outcome).toMatchObject({
      status: "escalated",
      trigger: "loop",
      summary: expect.stringContaining("TodoList > empty state"),
    });
    // Whatever a person decides next starts from code.
    expect(sliceStatus().status).toBe("building");
  });

  it("escalates after the Retry Budget, when each attempt fails differently", async () => {
    const { runner, input, calls } = await setup({
      results: ["a", "b", "c", "d"].map((sig) => failing(frontendFailure(sig))),
    });

    const outcome = await runner.runSlice(input());

    expect(outcome).toMatchObject({
      status: "escalated",
      trigger: "retryBudget",
    });
    // Both sides once, then three frontend retries.
    expect(calls).toHaveLength(5);
  });

  it("gives a fresh Retry Budget after a person's hint, and passes the hint on", async () => {
    const { runner, input, calls } = await setup({
      results: [
        ...["a", "b", "c", "d"].map((sig) => failing(frontendFailure(sig))),
        passing(),
      ],
    });
    await runner.runSlice(input());

    const outcome = await runner.runSlice(
      input({ hint: "The list must render before the fetch resolves." }),
    );

    expect(outcome).toMatchObject({ status: "passed" });
    expect(calls.at(-1)!.issues).toEqual([
      "A person reviewed the last failure and says:",
    ]);
  });

  it("escalates when the Token Budget is spent", async () => {
    const { runner, input, calls } = await setup({
      tokens: 1500,
      results: [failing(frontendFailure("a"))],
    });

    const outcome = await runner.runSlice(input());

    expect(outcome).toMatchObject({
      status: "escalated",
      trigger: "tokenBudget",
    });
    expect(calls).toHaveLength(2);
  });

  it("escalates a failure no document or evidence assigns", async () => {
    const { runner, input } = await setup({
      results: [
        failing(
          issueReport({
            step: "install",
            failingTest: null,
            file: null,
            endpoint: null,
            suspectedOwner: null,
            error: "npm error code ETARGET",
          }),
        ),
      ],
    });

    const outcome = await runner.runSlice(input());

    expect(outcome).toMatchObject({
      status: "escalated",
      trigger: "undecidableOwner",
      reports: [expect.objectContaining({ step: "install" })],
    });
  });

  it("stops coding and asks for a document revision when a document is wrong", async () => {
    const uiSpec = goodUiSpec();
    uiSpec.screens[1]!.endpoints.push("DELETE /todos/{id}");
    const { runner, input, sliceStatus } = await setup({
      results: [
        failing(
          issueReport({
            failingTest: "DELETE /todos/{id} > removes a todo",
            endpoint: "DELETE /todos/{id}",
            suspectedOwner: "frontendCoding",
          }),
        ),
      ],
    });

    const outcome = await runner.runSlice(
      input({
        documents: { ...input().documents, uiSpec },
      }),
    );

    expect(outcome).toMatchObject({
      status: "designIssue",
      revisions: [{ owner: "uiDesign" }],
    });
    expect(sliceStatus().status).toBe("building");
  });

  it("builds only the sides a Slice needs", async () => {
    const backendOnly = { ...TODOS, title: "Reports" };
    const { runner, input, calls } = await setup({
      plan: backendOnly,
      results: [passing()],
    });

    await runner.runSlice(input());

    expect(calls.map((call) => call.side)).toEqual(["backend"]);
  });
});
