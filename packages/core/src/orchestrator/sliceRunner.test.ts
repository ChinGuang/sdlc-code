/**
 * The Slice runner against real git Workspaces and a real database, with
 * scripted Coding and Testing Agents: pass, retry, Loop, budgets, Owners.
 */
import { REACT_NODE, templateFiles } from "@sdlc-code/stack-profiles";
import type { CodingSide } from "@sdlc-code/stack-profiles";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// These tests drive real git (many process spawns per test): 2-4s each alone on
// Windows, and far longer when every Vitest project runs at once. The time is
// real work, so this file alone gets a longer timeout than the 5s default.
vi.setConfig({ testTimeout: 60_000 });

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

/** What a fake Coding Agent does on a call: write its file (default), or not. */
type Behaviour =
  | "write"
  | "nothing"
  | "throw"
  | { stop: AgentLoopResult["stopReason"] }
  | { path: string; contents: string };

async function setup(options: {
  results: TestSliceResult[];
  tokens?: number;
  plan?: typeof TODOS;
  retryBudget?: number;
  /** Per side, what each of its calls does, in order. */
  behave?: Partial<Record<CodingSide, Behaviour[]>>;
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
  const checkpoints: string[] = [];
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
      const behaviour = options.behave?.[side]?.shift() ?? "write";
      if (behaviour === "throw") {
        // The half-written file a crash leaves behind.
        writeFileSync(join(input.workspaceDir, "server-crash.txt"), "x");
        throw new Error(`${side} agent crashed`);
      }
      if (typeof behaviour === "object" && "stop" in behaviour)
        return {
          summary: null,
          problem: "notAnswered",
          changes: [],
          loop: { ...loop(), stopReason: behaviour.stop, answer: null },
        };
      if (behaviour === "nothing")
        return {
          summary: "Nothing to change.",
          problem: "noChanges",
          changes: [],
          loop: loop(),
        };
      // Each attempt changes the side's own file, as a real fix would.
      const path =
        typeof behaviour === "object"
          ? behaviour.path
          : side === "backend"
            ? "server/todos.ts"
            : "src/TodoList.tsx";
      const file = join(input.workspaceDir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        typeof behaviour === "object"
          ? behaviour.contents
          : `// attempt ${calls.length}\n`,
      );
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
    retryBudget: options.retryBudget,
    checkpoint: (checkpoint) => checkpoints.push(checkpoint.at),
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
  const testsLeft = () => results.length;
  return {
    runner,
    input,
    calls,
    tasks,
    runId,
    workspaces,
    sliceStatus,
    checkpoints,
    testsLeft,
  };
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
    const first = await runner.runSlice(input());
    expect(first).toMatchObject({
      status: "escalated",
      trigger: "retryBudget",
    });
    if (first.status !== "escalated") return;

    const outcome = await runner.runSlice(
      input({
        history: first.history,
        hint: "The list must render before the fetch resolves.",
      }),
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

  it("uses a configured Retry Budget", async () => {
    const { runner, input, calls } = await setup({
      retryBudget: 1,
      results: ["a", "b"].map((sig) => failing(frontendFailure(sig))),
    });

    const outcome = await runner.runSlice(input());

    expect(outcome).toMatchObject({ trigger: "retryBudget" });
    expect(calls).toHaveLength(3);
  });

  it("marks the checkpoints diagram 6 needs", async () => {
    const { runner, input, checkpoints } = await setup({
      results: [failing(frontendFailure("a")), passing()],
    });

    await runner.runSlice(input());

    expect(checkpoints).toEqual(["merged", "retrying", "merged", "committed"]);
  });
});

describe("OrchestratedSliceRunner across calls", () => {
  it("does not refill the Retry Budget without a person's hint", async () => {
    const { runner, input, calls } = await setup({
      results: ["a", "b", "c", "d", "e"].map((sig) =>
        failing(frontendFailure(sig)),
      ),
    });
    const first = await runner.runSlice(input());
    if (first.status !== "escalated") throw new Error("expected an Escalation");
    const callsBefore = calls.length;

    const again = await runner.runSlice(input({ history: first.history }));

    expect(again).toMatchObject({
      status: "escalated",
      trigger: "retryBudget",
    });
    // Both sides build once more, and the failure escalates at once.
    expect(calls.length - callsBefore).toBe(2);
  });

  it("escalates as a Loop when a document revision did not help", async () => {
    const uiSpec = goodUiSpec();
    uiSpec.screens[1]!.endpoints.push("DELETE /todos/{id}");
    const wrongDocument = issueReport({
      failingTest: "DELETE /todos/{id} > removes a todo",
      endpoint: "DELETE /todos/{id}",
      suspectedOwner: "frontendCoding",
    });
    const { runner, input } = await setup({
      results: [failing(wrongDocument), failing(wrongDocument)],
    });
    const documents = { ...input().documents, uiSpec };
    const first = await runner.runSlice(input({ documents }));
    if (first.status !== "designIssue") throw new Error("expected a revision");

    const again = await runner.runSlice(
      input({ documents, history: first.history }),
    );

    expect(again).toMatchObject({ status: "escalated", trigger: "loop" });
  });

  it("refuses a Slice that already passed, leaving its Tasks done", async () => {
    const { runner, input, tasks, runId, sliceStatus } = await setup({
      results: [passing()],
    });
    await runner.runSlice(input());

    await expect(
      runner.runSlice(input({ slice: sliceStatus() })),
    ).rejects.toThrow(/is passed; there is nothing left to build/);
    expect(tasks.listTasks(runId).map((task) => task.status)).toEqual([
      "done",
      "done",
    ]);
  });
});

describe("OrchestratedSliceRunner when a Step goes wrong", () => {
  it("lets the other side finish, discards the crashed Step and resets its Workspace", async () => {
    const { runner, input, tasks, runId, workspaces } = await setup({
      behave: { backend: ["throw"] },
      results: [passing()],
    });

    await expect(runner.runSlice(input())).rejects.toThrow(
      /backend agent crashed/,
    );

    const steps = tasks
      .listTasks(runId)
      .flatMap((task) => tasks.listSteps(task.id));
    expect(steps.map((step) => step.status).sort()).toEqual([
      "completed",
      "discarded",
    ]);
    const backend = await workspaces.openWorkspace(input().slice.id, "backend");
    expect(existsSync(join(backend.dir, "server-crash.txt"))).toBe(false);
    // The Slice can simply run again: no Step was left running.
    await expect(runner.runSlice(input())).resolves.toMatchObject({
      status: "passed",
    });
  });

  it("redoes a Step that stopped part-way, without spending a Test Run", async () => {
    const { runner, input, calls, testsLeft } = await setup({
      behave: { frontend: [{ stop: "maxIterations" }] },
      results: [passing()],
    });

    const outcome = await runner.runSlice(input());

    expect(outcome).toMatchObject({ status: "passed", attempts: 2 });
    expect(calls.at(-1)).toMatchObject({
      side: "frontend",
      issues: [expect.stringContaining("ran out of turns")],
    });
    expect(testsLeft()).toBe(0);
  });

  it("escalates when a Step stopped because the Token Budget ran out", async () => {
    const { runner, input } = await setup({
      behave: { backend: [{ stop: "tokenBudget" }] },
      results: [],
    });

    await expect(runner.runSlice(input())).resolves.toMatchObject({
      status: "escalated",
      trigger: "tokenBudget",
    });
  });

  it("does not test the same code again when a retry changed nothing", async () => {
    const { runner, input, testsLeft } = await setup({
      behave: { frontend: ["write", "nothing"] },
      results: [failing(frontendFailure("a")), passing()],
    });

    const outcome = await runner.runSlice(input());

    expect(outcome).toMatchObject({
      status: "escalated",
      trigger: "loop",
      reports: [expect.objectContaining({ signature: "a" })],
    });
    expect(testsLeft()).toBe(1);
  });

  it("escalates a merge conflict between the two sides", async () => {
    const manifest = (name: string) =>
      `${JSON.stringify({ name: "app", dependencies: { react: name } }, null, 2)}\n`;
    const { runner, input } = await setup({
      behave: {
        backend: [{ path: "package.json", contents: manifest("^18.0.0") }],
        frontend: [{ path: "package.json", contents: manifest("^19.1.0") }],
      },
      results: [],
    });

    await expect(runner.runSlice(input())).resolves.toMatchObject({
      status: "escalated",
      trigger: "undecidableOwner",
      summary: expect.stringContaining("package.json"),
    });
  });

  it("escalates a Test Run that never finished", async () => {
    const run = passing().testRun;
    const { runner, input } = await setup({
      results: [
        {
          passed: false,
          issueReports: [
            issueReport({
              step: "sandbox",
              failingTest: null,
              file: null,
              endpoint: null,
              suspectedOwner: null,
              error: "The sandbox run timed out.",
            }),
          ],
          testRun: {
            status: "broken",
            problem: "The sandbox run timed out.",
            evidence: run.evidence,
          },
        },
      ],
    });

    await expect(runner.runSlice(input())).resolves.toMatchObject({
      status: "escalated",
      trigger: "undecidableOwner",
    });
  });

  it("records no retry for one side when the other side escalates", async () => {
    const { runner, input, tasks, runId } = await setup({
      results: [
        failing(
          issueReport({ signature: "backend-a" }),
          frontendFailure("front-a"),
        ),
        failing(
          issueReport({ signature: "backend-b" }),
          frontendFailure("front-a"),
        ),
      ],
    });

    const outcome = await runner.runSlice(input());

    expect(outcome).toMatchObject({ trigger: "loop" });
    expect(
      tasks.listTasks(runId).map((task) => [task.agentRole, task.retries]),
    ).toEqual([
      ["backendCoding", 1],
      ["frontendCoding", 1],
    ]);
  });
});
