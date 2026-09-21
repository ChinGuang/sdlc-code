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

const live = process.env.STACK_PROFILE_LIVE === "1";
const run = promisify(execFile);
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function copyTemplate(): string {
  const directory = mkdtempSync(join(tmpdir(), "sdlc-template-"));
  directories.push(directory);
  cpSync(REACT_NODE.templateDir, directory, { recursive: true });
  return directory;
}

async function runTestScript(directory: string) {
  const [command, ...args] = REACT_NODE.testCommand.split(" ");
  const { stdout } = await run(command!, args, {
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

describe.runIf(!live)("the template test script", () => {
  it("is skipped unless STACK_PROFILE_LIVE=1 (it installs dependencies)", () => {
    expect(REACT_NODE.testCommand).toBe("node scripts/sdlcTest.mjs");
  });
});
