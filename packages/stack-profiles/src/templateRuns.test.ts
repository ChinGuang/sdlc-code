// SPDX-License-Identifier: MPL-2.0
/**
 * Runs the template's own test script, end to end, against a copy in a temp
 * folder. It installs dependencies, so it is opt-in:
 *
 *   STACK_PROFILE_LIVE=1 pnpm --filter @sdlc-code/stack-profiles test
 */
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { REACT_NODE } from "./stackProfile.js";
import {
  failureSignature,
  parseTestScriptOutput,
  TEST_STEPS,
} from "./testScriptResult.js";
import {
  parseLintScriptOutput,
  type LintScriptResult,
} from "./lintScriptResult.js";

const live = process.env.STACK_PROFILE_LIVE === "1";
const run = promisify(execFile);
const directories: string[] = [];

// Deleting three installed copies of the application takes longer than a
// hook's ten seconds, and leaving them behind fills the temp folder.
afterAll(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
}, 300_000);

function copyTemplate(): string {
  const directory = mkdtempSync(join(tmpdir(), "sdlc-template-"));
  directories.push(directory);
  cpSync(REACT_NODE.templateDir, directory, { recursive: true });
  return directory;
}

async function runLintScript(directory: string) {
  const [command, ...args] = REACT_NODE.lintCommand.split(" ");
  const { stdout } = await run(command!, args, {
    cwd: directory,
    maxBuffer: 50 * 1024 * 1024,
  }).catch((error: { stdout?: string; stderr?: string }) => ({
    stdout: `${error.stdout ?? ""}${error.stderr ?? ""}`,
  }));
  return stdout;
}

async function runTestScript(directory: string, ...extra: string[]) {
  const [command, ...args] = REACT_NODE.testCommand.split(" ");
  const { stdout } = await run(command!, [...args, ...extra], {
    cwd: directory,
    maxBuffer: 50 * 1024 * 1024,
  }).catch((error: { stdout?: string; stderr?: string }) => ({
    stdout: `${error.stdout ?? ""}${error.stderr ?? ""}`,
  }));
  return stdout;
}

describe.runIf(live)("the template passes its own test script", () => {
  it(
    "installs, tests, boots and smoke-tests the Walking Skeleton",
    { timeout: 900_000 },
    async () => {
      const directory = copyTemplate();

      const parsed = parseTestScriptOutput(await runTestScript(directory));

      expect(parsed).not.toHaveProperty("problem");
      const { result } = parsed as Extract<typeof parsed, { result: unknown }>;
      expect(result.steps.map((step) => step.name)).toEqual([...TEST_STEPS]);
      expect(failureSignature(result)).toEqual([]);
      expect(result.passed).toBe(true);
    },
  );

  it(
    "reports the failing test by name when the application is broken",
    { timeout: 900_000 },
    async () => {
      const directory = copyTemplate();
      // A Slice whose test does not hold, as a Coding Agent would leave it.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        join(directory, "server", "todos.test.ts"),
        [
          'import { describe, expect, it } from "vitest";',
          "",
          'describe("Todos", () => {',
          '  it("lists the todos", () => {',
          "    expect([]).toHaveLength(1);",
          "  });",
          "});",
          "",
        ].join("\n"),
      );

      const parsed = parseTestScriptOutput(await runTestScript(directory));

      const { result } = parsed as Extract<typeof parsed, { result: unknown }>;
      expect(result.passed).toBe(false);
      expect(failureSignature(result)).toEqual([
        "unit: Todos > lists the todos",
      ]);
    },
  );
});

describe.runIf(live)("the template passes its own lint script", () => {
  it(
    "finds nothing in the template, and finds what a Coding Agent breaks",
    { timeout: 900_000 },
    async () => {
      const directory = copyTemplate();
      // The lint script does not install; a Test Run has already done it.
      await runTestScript(directory, "--install-only");

      const clean = parseLintScriptOutput(await runLintScript(directory));

      expect(clean).not.toHaveProperty("problem");
      const { result } = clean as Extract<typeof clean, { result: unknown }>;
      expect(result.checks.map((check) => [check.name, check.ok])).toEqual([
        ["eslint", true],
        ["tsc", true],
      ]);
      expect(result.problems).toEqual([]);

      // An unused import (ESLint) and a type error (tsc), in one file.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        join(directory, "src", "Broken.tsx"),
        [
          'import { useState } from "react";',
          "",
          "export function Broken() {",
          '  const total: number = "three";',
          "  return <p>{total}</p>;",
          "}",
          "",
          // An underscore excuses an error caught and ignored, as it does an
          // unused argument: this must not be a Finding (T25f).
          "export function Quiet() {",
          "  try {",
          "    return JSON.parse('{}');",
          "  } catch (_) {",
          "    return null;",
          "  }",
          "}",
          "",
        ].join("\n"),
      );

      const broken = parseLintScriptOutput(await runLintScript(directory));
      const found = (
        broken as Extract<typeof broken, { result: LintScriptResult }>
      ).result;

      expect(found.checks.every((check) => check.ok)).toBe(false);
      expect(
        found.problems.map((problem) => [problem.tool, problem.file]),
      ).toEqual(
        expect.arrayContaining([
          ["eslint", "src/Broken.tsx"],
          ["tsc", "src/Broken.tsx"],
        ]),
      );
      expect(
        found.problems.filter(
          (problem) =>
            problem.rule === "@typescript-eslint/no-unused-vars" &&
            problem.message.includes("'_'"),
        ),
      ).toEqual([]);
      const typeError = found.problems.find(
        (problem) => problem.tool === "tsc",
      );
      expect(typeError?.rule).toMatch(/^TS\d+$/);
      expect(typeError?.line).toBeGreaterThan(0);
    },
  );
});

describe.runIf(!live)("the template scripts", () => {
  it("are skipped unless STACK_PROFILE_LIVE=1 (they install dependencies)", () => {
    expect(REACT_NODE.testCommand).toBe("node scripts/sdlcTest.mjs");
    expect(REACT_NODE.lintCommand).toBe("node scripts/sdlcLint.mjs");
  });
});
