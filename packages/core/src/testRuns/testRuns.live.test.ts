/**
 * Real Test Runs on Nebius Sandboxes: builds the React + Node Base Snapshot
 * (once; the image id is kept in a database in the temp folder), then runs the
 * template's tests from it. It spends sandbox credit, so it is opt-in:
 *
 *   NEBIUS_LIVE=1 pnpm --filter @sdlc-code/core test testRuns.live
 *
 * The key and project come from the environment or sdlc-code/.env.
 */
import { NebiusSandboxClient, type SandboxClient } from "@sdlc-code/clients";
import {
  failureSignature,
  REACT_NODE,
  templateFiles,
  TEST_STEPS,
} from "@sdlc-code/stack-profiles";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../persistence/database.js";
import { SqliteSnapshotStore } from "../persistence/snapshotStore.js";
import { SandboxBaseSnapshots } from "./baseSnapshots.js";
import type { UploadCache } from "./sandboxFiles.js";
import { SandboxTestRunner, type TestRunner } from "./testRunner.js";

const live = process.env.NEBIUS_LIVE === "1";

function liveRunner(): TestRunner {
  try {
    process.loadEnvFile(join(import.meta.dirname, "../../../../.env"));
  } catch {
    // no file: the environment must hold the values
  }
  const token = process.env.NEBIUS_API_KEY;
  const project = process.env.NEBIUS_AI_PROJECT;
  if (!token || !project)
    throw new Error(
      "Set NEBIUS_API_KEY and NEBIUS_AI_PROJECT (see .env.example)",
    );
  const sandbox: SandboxClient = new NebiusSandboxClient({
    token,
    project,
    baseUrl: process.env.NEBIUS_SANDBOX_URL || undefined,
  });
  const uploaded: UploadCache = new Map();
  const store = new SqliteSnapshotStore({
    db: openDatabase(join(tmpdir(), "sdlc-code-live-snapshots.db")),
  });
  return new SandboxTestRunner({
    sandbox,
    snapshots: new SandboxBaseSnapshots({ sandbox, store, uploaded }),
    uploaded,
  });
}

describe.runIf(live)("Test Runs on Nebius Sandboxes", () => {
  const runner = live ? liveRunner() : undefined;

  it(
    "passes the untouched template, uploading nothing",
    { timeout: 1_200_000 },
    async () => {
      const outcome = await runner!.runTests({
        profile: REACT_NODE,
        files: templateFiles(REACT_NODE),
      });

      expect(outcome.status, JSON.stringify(outcome, null, 2)).toBe("passed");
      if (outcome.status === "broken") return;
      expect(outcome.result.steps.map((step) => step.name)).toEqual([
        ...TEST_STEPS,
      ]);
      expect(outcome.evidence.changedFiles).toEqual([]);
      // The Base Snapshot already has the dependencies.
      expect(outcome.result.steps[0]!.output).toContain("already installed");
    },
  );

  it(
    "names the failing test of a broken Slice",
    { timeout: 1_200_000 },
    async () => {
      const outcome = await runner!.runTests({
        profile: REACT_NODE,
        files: [
          ...templateFiles(REACT_NODE),
          {
            path: "server/todos.test.ts",
            contents: [
              'import { describe, expect, it } from "vitest";',
              "",
              'describe("Todos", () => {',
              '  it("lists the todos", () => {',
              "    expect([]).toHaveLength(1);",
              "  });",
              "});",
              "",
            ].join("\n"),
          },
        ],
      });

      expect(outcome.status, JSON.stringify(outcome, null, 2)).toBe("failed");
      if (outcome.status === "broken") return;
      expect(failureSignature(outcome.result)).toEqual([
        "unit: Todos > lists the todos",
      ]);
      expect(outcome.evidence.changedFiles).toEqual(["server/todos.test.ts"]);
    },
  );
});

describe.runIf(!live)("Test Runs on Nebius Sandboxes", () => {
  it("are skipped unless NEBIUS_LIVE=1 (they spend sandbox credit)", () => {
    expect(REACT_NODE.snapshotCommand).toContain("--install-only");
  });
});
