import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseTestScriptOutput,
  REACT_NODE,
  type TemplateFile,
} from "@sdlc-code/stack-profiles";
import { describe, expect, it } from "vitest";
import type {
  TestRunner,
  TestRunOutcome,
  TestRunRequest,
} from "../../testRuns/testRunner.js";
import { SandboxTestingAgent, type TestingAgent } from "./testingAgent.js";

/** A Test Runner that replays a recorded run and remembers what it was given. */
function replaying(name: string): TestRunner & { requests: TestRunRequest[] } {
  const log = readFileSync(
    join(import.meta.dirname, "fixtures", `${name}.log`),
    "utf8",
  );
  const parsed = parseTestScriptOutput(log);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const requests: TestRunRequest[] = [];
  const outcome: TestRunOutcome = {
    status: parsed.result.passed ? "passed" : "failed",
    result: parsed.result,
    evidence: {
      operationId: "op",
      exitCode: parsed.result.passed ? 0 : 1,
      timedOut: false,
      durationSeconds: 12,
      cost: 0.002,
      log,
      changedFiles: [],
      removedFiles: [],
      withheldFiles: [],
    },
  };
  return {
    requests,
    runTests: async (request) => {
      requests.push(request);
      return outcome;
    },
  };
}

const files: TemplateFile[] = [{ path: "server/todos.ts", contents: "x" }];

describe("SandboxTestingAgent", () => {
  it("runs the merged Slice and reports a pass with no Issue Reports", async () => {
    const runner = replaying("passing");
    // Tests depend on the interface; only this factory knows the class.
    const agent: TestingAgent = new SandboxTestingAgent({ runner });

    const result = await agent.testSlice({ profile: REACT_NODE, files });

    expect(runner.requests).toEqual([{ profile: REACT_NODE, files }]);
    expect(result.passed).toBe(true);
    expect(result.issueReports).toEqual([]);
    expect(result.testRun.status).toBe("passed");
  });

  it("turns a failing run into Issue Reports for the Orchestrator", async () => {
    const agent: TestingAgent = new SandboxTestingAgent({
      runner: replaying("crashOnBoot"),
    });

    const result = await agent.testSlice({ profile: REACT_NODE, files });

    expect(result.passed).toBe(false);
    expect(result.issueReports.map((report) => report.step)).toEqual(["boot"]);
  });

  it("lets a sandbox that cannot be used reject, rather than report on the code", async () => {
    const agent: TestingAgent = new SandboxTestingAgent({
      runner: {
        runTests: async () => {
          throw new Error("Sandbox API POST /instances failed: 503");
        },
      },
    });

    await expect(
      agent.testSlice({ profile: REACT_NODE, files }),
    ).rejects.toThrow(/503/);
  });
});
