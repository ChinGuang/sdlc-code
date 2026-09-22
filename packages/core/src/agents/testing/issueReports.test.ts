/**
 * Parser fixtures are real Test Run output from Nebius Sandboxes, recorded by
 * `pnpm --filter @sdlc-code/core fixtures:testing`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseTestScriptOutput,
  REACT_NODE,
  type TestStep,
} from "@sdlc-code/stack-profiles";
import { describe, expect, it } from "vitest";
import type {
  TestRunEvidence,
  TestRunOutcome,
} from "../../testRuns/testRunner.js";
import {
  codingIssues,
  isLoop,
  issueReports,
  MAX_CODING_ISSUES,
  normalizeError,
  toCodingIssue,
  type IssueReport,
} from "./issueReports.js";

const evidence = (log: string): TestRunEvidence => ({
  operationId: "op",
  exitCode: 1,
  timedOut: false,
  durationSeconds: 10,
  cost: 0.001,
  log,
  changedFiles: [],
  removedFiles: [],
  withheldFiles: [],
});

/** The outcome the Test Runner reports for a recorded run. */
function recorded(name: string): TestRunOutcome {
  const log = readFileSync(
    join(import.meta.dirname, "fixtures", `${name}.log`),
    "utf8",
  );
  const parsed = parseTestScriptOutput(log);
  if ("problem" in parsed) throw new Error(parsed.problem);
  return {
    status: parsed.result.passed ? "passed" : "failed",
    result: parsed.result,
    evidence: evidence(log),
  };
}

const reportsFor = (name: string): IssueReport[] =>
  issueReports(recorded(name), REACT_NODE);

describe("issueReports from recorded Test Runs", () => {
  it("passing: no Issue Reports", () => {
    expect(recorded("passing").status).toBe("passed");
    expect(reportsFor("passing")).toEqual([]);
  });

  it("failing unit: one report per failing test, each suspecting its side", () => {
    const reports = reportsFor("failingUnit");

    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({
      step: "unit",
      failingTest: "POST /todos > rejects an empty title",
      file: "server/todos.test.ts",
      error: "AssertionError: expected 404 to be 400 // Object.is equality",
      suspectedOwner: "backendCoding",
    });
    expect(reports[1]).toMatchObject({
      step: "unit",
      failingTest: "TodoList > shows the empty state",
      file: "src/TodoList.test.tsx",
      suspectedOwner: "frontendCoding",
    });
    expect(reports[1]!.error).toMatch(/Unable to find an element/);
  });

  it("failing unit: evidence keeps the assertion and drops library stack frames", () => {
    const [backend] = reportsFor("failingUnit");

    expect(backend!.evidence).toContain("expected 404 to be 400");
    expect(backend!.evidence).toContain("/app/server/todos.test.ts:9:29");
    expect(backend!.evidence).not.toContain("node_modules/@vitest/runner");
    expect(backend!.evidence).not.toContain("node:internal");
    expect(backend!.evidence.length).toBeLessThanOrEqual(1501);
  });

  it("failing smoke: the API's wrong answer, suspected on the backend", () => {
    const reports = reportsFor("failingSmoke");

    expect(reports).toEqual([
      expect.objectContaining({
        step: "smoke",
        failingTest: null,
        endpoint: "GET /definitely-not-here",
        error:
          "Smoke test failed: GET /definitely-not-here: expected 404, got 200",
        suspectedOwner: "backendCoding",
      }),
    ]);
  });

  it("crash on boot: the thrown error and the file that threw", () => {
    const reports = reportsFor("crashOnBoot");

    expect(reports).toEqual([
      expect.objectContaining({
        step: "boot",
        failingTest: null,
        file: "server/main.ts",
        error: "Error: SESSION_SECRET is not set",
        suspectedOwner: "backendCoding",
      }),
    ]);
    expect(reports[0]!.evidence).toContain(
      "The API did not answer on port 3100.",
    );
    expect(reports[0]!.evidence).not.toContain("node:internal");
  });

  it("gives the same signature to the same failure in a later run", () => {
    const first = reportsFor("failingUnit");
    const again = reportsFor("failingUnit");

    expect(again.map((report) => report.signature)).toEqual(
      first.map((report) => report.signature),
    );
    expect(new Set(first.map((report) => report.signature)).size).toBe(2);
    expect(isLoop(again[0]!, first)).toBe(true);
    expect(isLoop(again[0]!, reportsFor("crashOnBoot"))).toBe(false);
  });
});

describe("issueReports for runs that never finished", () => {
  it("a broken Test Run is one sandbox report with no suspect", () => {
    const reports = issueReports(
      {
        status: "broken",
        problem:
          "The test script printed no SDLC_RESULT line; it did not finish. The sandbox run: timed out.",
        evidence: evidence("=== install ===\nadded 312 packages"),
      },
      REACT_NODE,
    );

    expect(reports).toEqual([
      expect.objectContaining({
        step: "sandbox",
        failingTest: null,
        suspectedOwner: null,
        error: expect.stringContaining("did not finish"),
        evidence: "=== install ===\nadded 312 packages",
      }),
    ]);
  });

  it("an install failure points at no one: package.json is shared", () => {
    const outcome = recorded("passing");
    if (outcome.status === "broken") throw new Error("unexpected");
    const failed: TestRunOutcome = {
      ...outcome,
      status: "failed",
      result: {
        ...outcome.result,
        passed: false,
        steps: [
          {
            name: "install",
            ok: false,
            durationMs: 900,
            output:
              "npm error code ETARGET\nnpm error notarget No matching version found for zod@^99.0.0.",
            failures: [],
          },
        ],
      },
    };

    expect(issueReports(failed, REACT_NODE)).toEqual([
      expect.objectContaining({
        step: "install",
        error: "npm error code ETARGET",
        suspectedOwner: null,
      }),
    ]);
  });
});

describe("normalizeError", () => {
  it("keeps what identifies a failure and drops what changes between runs", () => {
    expect(
      normalizeError(
        "\u001b[31mError: timed out after 5000ms at server/todos.ts:12:7 (run 3f9a0c1d2e)\u001b[39m",
      ),
    ).toBe(
      "Error: timed out after <time> at server/todos.ts:<line> (run <id>)",
    );
    expect(normalizeError("expected 404 to be 400")).toBe(
      "expected 404 to be 400",
    );
  });
});

describe("toCodingIssue", () => {
  it("tells the owning Coding Agent what failed, where, and the evidence", () => {
    const [backend] = reportsFor("failingUnit");

    expect(toCodingIssue(backend!)).toEqual({
      summary:
        "POST /todos > rejects an empty title (server/todos.test.ts): AssertionError: expected 404 to be 400 // Object.is equality",
      evidence: backend!.evidence,
    });
    expect(toCodingIssue(reportsFor("failingSmoke")[0]!).summary).toMatch(
      /^smoke step: Smoke test failed/,
    );
  });
});

/** A failed run whose steps are given directly, for inputs no fixture has. */
function failedWith(...steps: TestStep[]): TestRunOutcome {
  return {
    status: "failed",
    result: { profile: "react-node", passed: false, steps, durationMs: 1 },
    evidence: evidence(""),
  };
}

const step = (
  name: TestStep["name"],
  output: string,
  failures: TestStep["failures"] = [],
): TestStep => ({ name, ok: false, durationMs: 1, output, failures });

// Inputs from the T16 standards review, each wrong in the first version.
describe("issueReports heuristics", () => {
  it("blames a crashed unit run on the file in the error, not on a warning before it", () => {
    const [report] = issueReports(
      failedWith(
        step(
          "unit",
          [
            "stderr | server/app.test.ts > GET /health > reports the API",
            "prisma:warn Prisma failed to detect the libssl/openssl version",
            "Prisma schema loaded from prisma/schema.prisma",
            "Error: Failed to load url ./Missing.js (resolved id: ./Missing.js) in /app/src/App.tsx. Does the file exist?",
          ].join("\n"),
        ),
      ),
      REACT_NODE,
    );

    expect(report).toMatchObject({
      file: "src/App.tsx",
      suspectedOwner: "frontendCoding",
    });
  });

  it("never takes a path inside node_modules for an application file", () => {
    const [report] = issueReports(
      failedWith(
        step(
          "unit",
          "TypeError: x is not a function\n    at x (/app/node_modules/some-lib/src/index.js:3:1)",
        ),
      ),
      REACT_NODE,
    );

    expect(report).toMatchObject({ file: null, suspectedOwner: null });
  });

  it("tells two different boot failures apart when neither printed an Error line", () => {
    const [listening] = issueReports(
      failedWith(
        step(
          "boot",
          "Listening on 4000\n\nThe API did not answer on port 3100.",
        ),
      ),
      REACT_NODE,
    );
    const [exiting] = issueReports(
      failedWith(
        step(
          "boot",
          "DATABASE_URL missing, exiting\n\nThe API did not answer on port 3100.",
        ),
      ),
      REACT_NODE,
    );

    expect(listening!.error).toBe("Listening on 4000");
    expect(exiting!.error).toBe("DATABASE_URL missing, exiting");
    expect(listening!.signature).not.toBe(exiting!.signature);
  });

  it("merges the same failure in many tests into one report, counting them", () => {
    const failure = (test: string) => ({
      test,
      file: "/app/server/todos.test.ts",
      message: "Error: connect ECONNREFUSED",
    });
    const reports = issueReports(
      failedWith(step("unit", "", [failure("a"), failure("a"), failure("b")])),
      REACT_NODE,
    );

    expect(
      reports.map((report) => [report.failingTest, report.occurrences]),
    ).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
  });

  it("does not take a test of the same name in another file for a Loop", () => {
    const failure = (file: string) => ({
      test: "renders",
      file,
      message: "Error: boom",
    });
    const reports = issueReports(
      failedWith(
        step("unit", "", [
          failure("/app/src/List.test.tsx"),
          failure("/app/src/Form.test.tsx"),
        ]),
      ),
      REACT_NODE,
    );

    expect(reports).toHaveLength(2);
    expect(isLoop(reports[0]!, [reports[1]!])).toBe(false);
  });

  it("names the endpoint a test is about, for the Orchestrator", () => {
    expect(reportsFor("failingUnit")[0]!.endpoint).toBe("POST /todos");
    expect(reportsFor("failingUnit")[1]!.endpoint).toBeNull();
  });

  it("keeps a :param path whole, and stops at a label's colon", () => {
    const endpointOf = (test: string) =>
      issueReports(
        failedWith(
          step("unit", "", [
            { test, file: "/app/server/x.test.ts", message: "Error: x" },
          ]),
        ),
        REACT_NODE,
      )[0]!.endpoint;

    expect(endpointOf("DELETE /todos/:id > removes it")).toBe(
      "DELETE /todos/:id",
    );
    expect(endpointOf("GET /todos: lists them")).toBe("GET /todos");
  });
});

describe("normalizeError edge cases", () => {
  it("drops a whole timestamp and a whole UUID", () => {
    expect(
      normalizeError(
        "at 2026-09-22T06:09:46.123Z for 3f2c1a9b-1c2d-4e5f-8a9b-0123456789ab",
      ),
    ).toBe("at <timestamp> for <uuid>");
  });

  it("keeps plain numbers and words that only look like timings", () => {
    expect(normalizeError("expected 12345678 to be 1")).toBe(
      "expected 12345678 to be 1",
    );
    expect(normalizeError("k8s down")).toBe("k8s down");
  });
});

describe("codingIssues", () => {
  it("gives a Coding Agent at most ten Issue Reports, and names the rest", () => {
    const failures = Array.from({ length: 13 }, (_, index) => ({
      test: `test ${index}`,
      file: "/app/server/todos.test.ts",
      message: `Error: failure ${index}`,
    }));
    const reports = issueReports(
      failedWith(step("unit", "", failures)),
      REACT_NODE,
    );

    const issues = codingIssues(reports);

    expect(issues).toHaveLength(MAX_CODING_ISSUES + 1);
    expect(issues.at(-1)!.summary).toBe(
      "3 more failures not listed; fix these first.",
    );
    expect(issues.at(-1)!.evidence).toContain("- test 12: Error: failure 12");
  });
});
