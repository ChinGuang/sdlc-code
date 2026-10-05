// SPDX-License-Identifier: MPL-2.0
import { SandboxApiError, type SpawnRequest } from "@sdlc-code/clients";
import { REACT_NODE, type TemplateFile } from "@sdlc-code/stack-profiles";
import { describe, expect, it } from "vitest";
import type { BaseSnapshots } from "./baseSnapshots.js";
import {
  fakeSandbox,
  lintOutput,
  ranOk,
  type FakeSandbox,
} from "./fixtures/fakeSandbox.js";
import {
  lintCommand,
  SandboxLintRunner,
  type LintRunner,
} from "./lintRunner.js";

const TEMPLATE: TemplateFile[] = [
  { path: "package.json", contents: "{}" },
  { path: "server/app.ts", contents: "app v1" },
  { path: "src/App.tsx", contents: "screen v1" },
];

const CLEAN = lintOutput([]);

function fakeSnapshots(): BaseSnapshots & { discarded: number } {
  const snapshots = {
    discarded: 0,
    snapshotImage: async () => `snapshot-${snapshots.discarded}`,
    discardSnapshot: () => void snapshots.discarded++,
  };
  return snapshots;
}

function setup(onRun?: (request: SpawnRequest) => ReturnType<typeof ranOk>) {
  const sandbox: FakeSandbox = fakeSandbox({
    onRun: onRun ?? (() => ranOk({ stdout: CLEAN, resultImage: null })),
  });
  const snapshots = fakeSnapshots();
  // Tests depend on the interface; only this factory knows the class.
  const runner: LintRunner = new SandboxLintRunner({
    sandbox,
    snapshots,
    files: () => TEMPLATE,
  });
  return { runner, sandbox, snapshots };
}

const slice = (changes: TemplateFile[] = []): TemplateFile[] => [
  ...TEMPLATE.filter((file) => !changes.some((c) => c.path === file.path)),
  ...changes,
];

describe("SandboxLintRunner", () => {
  it("runs the profile's lint script on the Base Snapshot, uploading only changes", async () => {
    const { runner, sandbox } = setup();

    const outcome = await runner.runLinters({
      profile: REACT_NODE,
      files: slice([{ path: "src/App.tsx", contents: "screen v2" }]),
    });

    expect(outcome.status).toBe("linted");
    const [request] = sandbox.runs;
    expect(request?.image).toBe("snapshot-0");
    expect(request?.command).toContain(REACT_NODE.lintCommand);
    expect(request?.disposable).toBe(true);
    // Only the changed screen is uploaded; the rest is in the Snapshot.
    expect(Object.keys(request?.files ?? {})).toEqual(["/app/src/App.tsx"]);
  });

  it("reports what the linters found, with the tool's own rule name", async () => {
    const { runner } = setup(() =>
      ranOk({
        exitCode: 1,
        stdout: lintOutput([
          { tool: "eslint", severity: "error", rule: "no-unused-vars" },
          {
            tool: "tsc",
            file: "server/app.ts",
            line: 12,
            rule: "TS2322",
            message: "Type 'string' is not assignable to type 'number'.",
          },
        ]),
      }),
    );

    const outcome = await runner.runLinters({
      profile: REACT_NODE,
      files: slice(),
    });

    if (outcome.status !== "linted") throw new Error(outcome.problem);
    expect(
      outcome.result.problems.map((problem) => [problem.tool, problem.rule]),
    ).toEqual([
      ["eslint", "no-unused-vars"],
      ["tsc", "TS2322"],
    ]);
    expect(outcome.evidence.exitCode).toBe(1);
  });

  it("finding nothing is a clean run, not a broken one", async () => {
    const { runner } = setup();

    const outcome = await runner.runLinters({
      profile: REACT_NODE,
      files: slice(),
    });

    expect(outcome).toMatchObject({ status: "linted" });
    if (outcome.status !== "linted") throw new Error("expected a result");
    expect(outcome.result.problems).toEqual([]);
  });

  it("is broken when the script printed no result", async () => {
    const { runner } = setup(() =>
      ranOk({ exitCode: 1, stdout: "eslint: command not found\n" }),
    );

    const outcome = await runner.runLinters({
      profile: REACT_NODE,
      files: slice(),
    });

    expect(outcome.status).toBe("broken");
    if (outcome.status !== "broken") throw new Error("expected broken");
    expect(outcome.problem).toMatch(/printed no SDLC_LINT line/);
    expect(outcome.evidence.log).toContain("command not found");
  });

  // A tool that says nothing and then fails has not checked the application.
  it("is broken when nothing was reported but the run did not succeed", async () => {
    const { runner } = setup(() =>
      ranOk({ exitCode: 137, stdout: CLEAN, status: "FAILED" }),
    );

    const outcome = await runner.runLinters({
      profile: REACT_NODE,
      files: slice(),
    });

    expect(outcome).toMatchObject({ status: "broken" });
  });

  it("names the tool that could not run, keeping what the other found", async () => {
    const { runner } = setup(() =>
      ranOk({
        exitCode: 1,
        stdout: lintOutput(
          [{ tool: "tsc", rule: "TS2322", message: "Type error." }],
          [
            {
              name: "eslint",
              ok: false,
              output: "Cannot find eslint.config.js",
            },
            { name: "tsc", ok: false },
          ],
        ),
      }),
    );

    const outcome = await runner.runLinters({
      profile: REACT_NODE,
      files: slice(),
    });

    if (outcome.status !== "linted") throw new Error("expected a result");
    expect(
      outcome.result.checks.map((check) => [check.name, check.ok]),
    ).toEqual([
      ["eslint", false],
      ["tsc", false],
    ]);
  });

  it("starts over once when the Snapshot or an upload has expired", async () => {
    let calls = 0;
    const { runner, snapshots } = setup(() => {
      calls++;
      if (calls === 1) throw new SandboxApiError(410, "image is gone");
      return ranOk({ stdout: CLEAN });
    });

    const outcome = await runner.runLinters({
      profile: REACT_NODE,
      files: slice(),
    });

    expect(outcome.status).toBe("linted");
    expect(snapshots.discarded).toBe(1);
    expect(calls).toBe(2);
  });

  it("lets a sandbox failure that is not expiry through", async () => {
    const { runner } = setup(() => {
      throw new SandboxApiError(500, "sandbox exploded");
    });

    await expect(
      runner.runLinters({ profile: REACT_NODE, files: slice() }),
    ).rejects.toThrow(/sandbox exploded/);
  });
});

describe("lintCommand", () => {
  it("runs in the application, logs to a file and prints the log's end", () => {
    const command = lintCommand(REACT_NODE, []);

    expect(command).toContain("cd '/app'");
    expect(command).toContain(REACT_NODE.lintCommand);
    expect(command).toContain(".sdlc/lint.log");
    expect(command).toContain("tail -c");
  });

  it("removes files the application no longer has before linting them", () => {
    expect(lintCommand(REACT_NODE, ["src/Old.tsx"])).toContain(
      "rm -f -- 'src/Old.tsx'",
    );
  });
});
