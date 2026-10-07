// SPDX-License-Identifier: MPL-2.0
/**
 * The runtime's handling of its keys, without calling anything real: it checks
 * them before opening anything, and none of them can leave it on an event, a
 * property or an error it passes on.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAgentConfig } from "../config/agentConfig.js";
import {
  createRunRuntime,
  MAX_PARALLEL_SLICES_LIMIT,
  maxParallelSlices,
  MissingKeyError,
  type RunRuntime,
  type RunRuntimeOptions,
} from "./runRuntime.js";
import type { RuntimeEvent } from "./runtimeEvents.js";

// A real scaffold into a real git repository: slow under a loaded suite.
vi.setConfig({ testTimeout: 60_000 });

const API_KEY = "tf-secret-key-123";
const PENPOT_TOKEN = "penpot-user-token-456";
const GITHUB_TOKEN = "ghp-secret-789";

const folders: string[] = [];
const runtimes: RunRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

const ENV = {
  NEBIUS_API_KEY: API_KEY,
  NEBIUS_AI_PROJECT: "project-1",
  PENPOT_MCP_URL: `https://design.penpot.app/mcp/stream?userToken=${PENPOT_TOKEN}`,
  GITHUB_TOKEN,
};

function make(
  env: Record<string, string | undefined> = ENV,
  overrides: Partial<RunRuntimeOptions> = {},
) {
  const dataDir = join(mkdtempSync(join(tmpdir(), "sdlc-runtime-")), "data");
  folders.push(join(dataDir, ".."));
  const events: RuntimeEvent[] = [];
  const runtime = createRunRuntime({
    dataDir,
    env,
    configPath: join(dataDir, "no-such-config.json"),
    config: parseAgentConfig(undefined, {}),
    events: { run: (event) => events.push(event) },
    ...overrides,
  });
  runtimes.push(runtime);
  return { runtime, events, dataDir };
}

describe("createRunRuntime: its keys", () => {
  // A runtime that cannot run must not leave a database open behind it.
  it("names a missing key, and opens nothing, before anything else", () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "sdlc-runtime-")), "data");
    folders.push(join(dataDir, ".."));

    for (const missing of [
      "NEBIUS_API_KEY",
      "NEBIUS_AI_PROJECT",
      "PENPOT_MCP_URL",
    ]) {
      const create = () =>
        createRunRuntime({
          dataDir,
          env: { ...ENV, [missing]: undefined },
          configPath: "none",
          config: parseAgentConfig(undefined, {}),
        });
      expect(create).toThrow(MissingKeyError);
      expect(create).toThrow(new RegExp(`^${missing} is not set`));
    }
    expect(existsSync(dataDir)).toBe(false);
  });

  it("never exposes a key as a property", () => {
    const { runtime } = make();

    const shown = JSON.stringify(runtime);
    for (const secret of [API_KEY, PENPOT_TOKEN, GITHUB_TOKEN])
      expect(shown).not.toContain(secret);
  });

  // A client that quotes a key in an error still cannot put it on a stream.
  it("takes its keys out of any text it is given", () => {
    const { runtime } = make();

    const redacted = runtime.redact(
      `401 for ${API_KEY}; tab ${ENV.PENPOT_MCP_URL}; token ${PENPOT_TOKEN}; push ${GITHUB_TOKEN}`,
    );

    for (const secret of [API_KEY, PENPOT_TOKEN, GITHUB_TOKEN])
      expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[redacted]");
  });

  // Found out now rather than after hours of work that cannot be pushed.
  it("refuses a Run with a Target Repo when it has no GITHUB_TOKEN", async () => {
    const { runtime } = make({ ...ENV, GITHUB_TOKEN: undefined });

    await expect(
      runtime.startRun({
        projectRequest: "Build a todo app",
        mode: "auto",
        tokenBudget: 1_000_000,
        targetRepo: "ChinGuang/demo",
      }),
    ).rejects.toThrow(/GITHUB_TOKEN is not set/);
    expect(runtime.runs.listRuns()).toEqual([]);
  });
});

describe("createRunRuntime: starting a Run", () => {
  it("scaffolds its repository and says where it is", async () => {
    const { runtime, events, dataDir } = make();

    const run = await runtime.startRun({
      projectRequest: "Build a todo app",
      mode: "auto",
      tokenBudget: 1_000_000,
    });

    expect(runtime.runDir(run.id)).toBe(join(dataDir, run.id));
    expect(existsSync(runtime.repoDir(run.id))).toBe(true);
    expect(run.targetRepo.owner).toBe("local");
    expect(events).toEqual([
      { runId: run.id, type: "status", status: "designing" },
    ]);
  });
});

describe("maxParallelSlices (S5)", () => {
  it("is one, the Slices one after another, unless asked for more", () => {
    expect(maxParallelSlices(undefined)).toBe(1);
    expect(maxParallelSlices("")).toBe(1);
    expect(maxParallelSlices("1")).toBe(1);
  });

  it("is what is asked for, up to the limit", () => {
    expect(maxParallelSlices("3")).toBe(3);
    expect(maxParallelSlices(String(MAX_PARALLEL_SLICES_LIMIT))).toBe(
      MAX_PARALLEL_SLICES_LIMIT,
    );
  });

  it.each(["0", "-1", "2.5", "many", "5", "1e3"])(
    "refuses %j, which is a mistake to stop for and not to pass over",
    (value) => {
      expect(() => maxParallelSlices(value)).toThrow(
        /SDLC_MAX_PARALLEL_SLICES must be a whole number from 1 to 4/,
      );
    },
  );
});
