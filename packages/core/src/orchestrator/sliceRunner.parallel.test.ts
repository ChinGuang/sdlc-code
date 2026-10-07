// SPDX-License-Identifier: MPL-2.0
/**
 * Two Slices built at the same time by one runner (S5), over real git and a
 * real database: their coding overlaps, their merge, test and commit take
 * turns, and a Slice that conflicts with what its peer committed starts over
 * on top of it instead of escalating.
 */
import { REACT_NODE, templateFiles } from "@sdlc-code/stack-profiles";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentLoopResult } from "../agentLoop/agentLoop.js";
import type { CodingAgent, CodingInput } from "../agents/coding/codingAgent.js";
import type { DesignSlice } from "../agents/systemDesign/design.js";
import { goodDesign } from "../agents/systemDesign/fixtures/goodDesign.js";
import type {
  TestingAgent,
  TestSliceResult,
} from "../agents/testing/testingAgent.js";
import { goodUiSpec } from "../agents/uiDesign/fixtures/goodUiSpec.js";
import { SqliteSliceStore } from "../persistence/sliceStore.js";
import { SqliteTaskStore } from "../persistence/taskStore.js";
import { databaseWithRun } from "../persistence/testDatabase.js";
import { GitWorkspaceManager } from "../workspaces/workspaceManager.js";
import { RuleOwnerResolver } from "./ownerResolution.js";
import {
  OrchestratedSliceRunner,
  type SliceRunInput,
  type SliceRunner,
} from "./sliceRunner.js";

vi.setConfig({ testTimeout: 60_000 });

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

const design = goodDesign();

/** A backend-only Slice: one endpoint, and no screen in the UI Spec. */
const slice = (title: string, path: string): DesignSlice => ({
  title,
  goal: `${title} works`,
  isWalkingSkeleton: false,
  dependsOn: [],
  endpoints: [`GET /${path}`],
});
const ALPHA = slice("Alpha", "alpha");
const BETA = slice("Beta", "beta");

const answered: AgentLoopResult = {
  stopReason: "answered",
  answer: "Done.",
  workingMemory: "- worked on it",
  iterations: 1,
  toolCalls: 1,
  failedToolCalls: 0,
  usage: { promptTokens: 1, completionTokens: 1 },
  error: null,
};

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

/** What a Slice's Coding Agent does on its nth call: the file it writes. */
type Script = (
  call: number,
  input: CodingInput,
) => Promise<{ path: string; contents: string }>;

async function setup(scripts: Record<string, Script>) {
  const root = mkdtempSync(join(tmpdir(), "sdlc-parallel-"));
  folders.push(root);
  const { runId, options: store } = databaseWithRun();
  const tasks = new SqliteTaskStore(store);
  const slices = new SqliteSliceStore(store);
  const stored = slices.saveSlices(runId, [
    { title: ALPHA.title, isWalkingSkeleton: false },
    { title: BETA.title, isWalkingSkeleton: false },
  ]);
  const workspaces = new GitWorkspaceManager({
    repoDir: join(root, "run.git"),
    runBranch: "sdlc/app",
    workspacesDir: join(root, "workspaces"),
  });
  await workspaces.startRun({
    scaffold: templateFiles(REACT_NODE),
    message: "Scaffold",
  });

  const events: string[] = [];
  let coding = 0;
  let mostCoding = 0;
  let testing = 0;
  let mostTesting = 0;
  const calls = new Map<string, CodingInput[]>();
  const committed = new Map<string, () => void>();
  const whenCommitted = (title: string) =>
    new Promise<void>((resolve) => committed.set(title, resolve));

  const testingAgent: TestingAgent = {
    testSlice: async () => {
      testing += 1;
      mostTesting = Math.max(mostTesting, testing);
      await new Promise((resolve) => setTimeout(resolve, 30));
      testing -= 1;
      return passing();
    },
  };
  const codingAgent = (): CodingAgent => ({
    code: async (input: CodingInput) => {
      const title = input.slice.title;
      const own = calls.get(title) ?? [];
      calls.set(title, [...own, input]);
      coding += 1;
      mostCoding = Math.max(mostCoding, coding);
      try {
        const { path, contents } = await scripts[title]!(own.length, input);
        const file = join(input.workspaceDir, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, contents);
        return {
          summary: "done",
          problem: null,
          changes: [{ path, kind: "written" as const }],
          loop: answered,
        };
      } finally {
        coding -= 1;
      }
    },
  });
  // Tests depend on the interface; only this factory knows the class.
  const runner: SliceRunner = new OrchestratedSliceRunner({
    workspaces,
    testing: testingAgent,
    owners: new RuleOwnerResolver(),
    tasks,
    slices,
    budget: { remaining: () => 1_000_000, spend: () => {} },
    codingAgent,
    checkpoint: (checkpoint) => {
      if (checkpoint.at === "retrying") {
        const title = stored.find(
          (one) => one.id === checkpoint.sliceId,
        )!.title;
        events.push(
          `retrying ${title}: ${Object.keys(checkpoint.history.pending ?? {}).join()}`,
        );
      }
      if (checkpoint.at === "committed") {
        const title = stored.find(
          (one) => one.id === checkpoint.sliceId,
        )!.title;
        events.push(`committed ${title}`);
        committed.get(title)?.();
      }
    },
  });
  const input = (index: number, plan: DesignSlice): SliceRunInput => ({
    runId,
    slice: stored[index]!,
    plan,
    profile: REACT_NODE,
    projectRequest: "An app",
    documents: {
      systemDesign: "# System Design",
      slicePlan: [...design.slicePlan, ALPHA, BETA],
      apiContract: design.apiContract,
      uiSpec: goodUiSpec(),
    },
    capabilities: {
      backend: { vision: false, penpotMcp: false },
      frontend: { vision: false, penpotMcp: false },
    },
    screenImages: new Map(),
    penpotPage: null,
  });
  return {
    runner,
    input,
    workspaces,
    slices,
    runId,
    calls,
    events,
    whenCommitted,
    most: () => ({ coding: mostCoding, testing: mostTesting }),
  };
}

describe("OrchestratedSliceRunner: Slices built at the same time (S5)", () => {
  it("codes both at once, takes turns testing, and commits one on top of the other", async () => {
    // Each waits for the other to be coding too, so they provably overlap.
    let arrived = 0;
    let overlapped: () => void = () => {};
    const both = new Promise<void>((resolve) => {
      overlapped = () => {
        if (++arrived === 2) resolve();
      };
    });
    const meet: Script = async (_call, input) => {
      overlapped();
      await both;
      return {
        path: `server/${input.slice.title.toLowerCase()}.ts`,
        contents: "export const ok = true;\n",
      };
    };
    const { runner, input, workspaces, most, slices, runId } = await setup({
      Alpha: meet,
      Beta: meet,
    });

    const [a, b] = await Promise.all([
      runner.runSlice(input(0, ALPHA)),
      runner.runSlice(input(1, BETA)),
    ]);

    expect(a.status).toBe("passed");
    expect(b.status).toBe("passed");
    expect(most().coding).toBe(2);
    // Testing, which changes the run branch's fate, is never done twice at once.
    expect(most().testing).toBe(1);
    expect(await workspaces.sliceCommits()).toHaveLength(2);
    // The second commit holds the first Slice's work: it was merged on top.
    const files = (
      await workspaces.readFiles(await workspaces.lastSliceCommit())
    ).map((file) => file.path);
    expect(files).toEqual(
      expect.arrayContaining(["server/alpha.ts", "server/beta.ts"]),
    );
    expect(
      slices.listSlices(runId).every((one) => one.status === "passed"),
    ).toBe(true);
  });

  // Both add the same file from the same base: the second to integrate would
  // conflict with the first's commit, which no retry of the same Workspace fixes.
  it("starts a Slice over on top of its peer's commit when they conflict, instead of escalating", async () => {
    const harness = await setup({
      Alpha: async () => ({
        path: "server/shared.ts",
        contents: "export const owner = 'alpha';\n",
      }),
      Beta: async (call) => {
        if (call === 0) {
          // Coding in step with Alpha: Beta finishes only after Alpha committed.
          await harness.whenCommitted("Alpha");
          return {
            path: "server/shared.ts",
            contents: "export const owner = 'beta';\n",
          };
        }
        return {
          path: "server/beta-only.ts",
          contents: "export const beta = 1;\n",
        };
      },
    });

    const [a, b] = await Promise.all([
      harness.runner.runSlice(harness.input(0, ALPHA)),
      harness.runner.runSlice(harness.input(1, BETA)),
    ]);

    expect(a.status).toBe("passed");
    expect(b.status).toBe("passed");
    // Written down like any retry, so a restart knows every side codes again.
    expect(harness.events).toContain("retrying Beta: backend");
    const second = harness.calls.get("Beta")!;
    expect(second).toHaveLength(2);
    expect(second[1]!.issueReports[0]!.summary).toMatch(
      /Another Slice was committed while you worked.*server\/shared\.ts/,
    );
    const files = await harness.workspaces.readFiles(
      await harness.workspaces.lastSliceCommit(),
    );
    const shared = files.find((file) => file.path === "server/shared.ts");
    // Alpha's version stays: Beta started again on top of it.
    expect(shared?.contents).toContain("alpha");
    expect(files.map((file) => file.path)).toContain("server/beta-only.ts");
  });

  it("builds a single Slice as it always did, with no peer to wait for", async () => {
    const { runner, input } = await setup({
      Alpha: async () => ({ path: "server/a.ts", contents: "a\n" }),
      Beta: async () => ({ path: "server/b.ts", contents: "b\n" }),
    });

    const outcome = await runner.runSlice(input(1, BETA));

    expect(outcome.status).toBe("passed");
  });
});
