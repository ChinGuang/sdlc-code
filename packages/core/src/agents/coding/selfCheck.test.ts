import {
  REACT_NODE,
  templateFiles,
  type TemplateFile,
  type TestStep,
} from "@sdlc-code/stack-profiles";
import { describe, expect, it } from "vitest";
import type {
  TestRunOutcome,
  TestRunRequest,
  TestRunner,
} from "../../testRuns/testRunner.js";
import {
  cheapFindings,
  SandboxSelfCheck,
  type SelfCheck,
} from "./selfCheck.js";

const evidence = {
  operationId: "op",
  exitCode: 1,
  timedOut: false,
  durationSeconds: 40,
  cost: 0.001,
  log: "",
  changedFiles: [],
  removedFiles: [],
  withheldFiles: [],
};

const ran = (...steps: TestStep[]): TestRunOutcome => ({
  status: steps.every((step) => step.ok) ? "passed" : "failed",
  result: {
    profile: "react-node",
    passed: steps.every((step) => step.ok),
    steps,
    durationMs: 1,
  },
  evidence,
});

const step = (name: TestStep["name"], ok: boolean, output = ""): TestStep => ({
  name,
  ok,
  durationMs: 1,
  output,
  failures: [],
});

/** A self-check whose sandbox answers `outcome`, recording each request. */
function checking(outcome: TestRunOutcome | Error) {
  const requests: TestRunRequest[] = [];
  const problems: string[] = [];
  const runner: TestRunner = {
    runTests: async (request) => {
      requests.push(request);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  // Tests depend on the interface; only this factory knows the class.
  const check: SelfCheck = new SandboxSelfCheck({
    runner,
    onProblem: (problem) => problems.push(problem),
  });
  return { check, requests, problems };
}

const template = templateFiles(REACT_NODE);
const withFile = (path: string, contents: string): TemplateFile[] => [
  ...template.filter((file) => file.path !== path),
  { path, contents },
];

describe("cheapFindings (T24j)", () => {
  // Run #e29ca700: Jest in the tests and @db.VarChar on SQLite.
  it("names each line that holds what a cheap check forbids, and what to do", () => {
    const files = [
      ...withFile(
        "src/screens/HealthScreen.test.tsx",
        'import { render } from "@testing-library/react";\n\njest.mock("../api.js");\n',
      ),
      {
        path: "prisma/schema.prisma",
        contents: "model Event {\n  title String @db.VarChar(200)\n}\n",
      },
    ];

    expect(cheapFindings(files, REACT_NODE, "frontend")).toEqual([
      {
        summary: expect.stringMatching(
          /^src\/screens\/HealthScreen\.test\.tsx:3: The tests run on Vitest, not Jest/,
        ),
        evidence: 'jest.mock("../api.js");',
      },
    ]);
    expect(cheapFindings(files, REACT_NODE, "backend")).toEqual([
      {
        summary: expect.stringMatching(
          /^prisma\/schema\.prisma:2: SQLite has no Prisma native types/,
        ),
        evidence: "title String @db.VarChar(200)",
      },
    ]);
  });

  it("finds nothing in the template itself", () => {
    expect(cheapFindings(template, REACT_NODE, "backend")).toEqual([]);
    expect(cheapFindings(template, REACT_NODE, "frontend")).toEqual([]);
  });
});

describe("SandboxSelfCheck (T24j)", () => {
  it("runs the side's own check in the sandbox, and passes work that passes it", async () => {
    const { check, requests } = checking(
      ran(step("install", true), step("typecheck", true), step("unit", true)),
    );

    expect(
      await check.check({
        profile: REACT_NODE,
        side: "backend",
        files: template,
      }),
    ).toBeNull();
    expect(requests).toEqual([
      {
        profile: REACT_NODE,
        files: template,
        command: "node scripts/sdlcTest.mjs --check backend",
      },
    ]);
  });

  it("sends a failing typecheck back, by file and line", async () => {
    const { check } = checking(
      ran(
        step("install", true),
        step(
          "typecheck",
          false,
          "src/screens/DeleteConfirmation.tsx(12,3): error TS2304: Cannot find name 'useEffect'.",
        ),
      ),
    );

    const problems = await check.check({
      profile: REACT_NODE,
      side: "frontend",
      files: template,
    });

    expect(problems).toMatch(/^Your work does not pass its own check yet/);
    expect(problems).toContain(
      "src/screens/DeleteConfirmation.tsx(12,3): error TS2304: Cannot find name 'useEffect'.",
    );
  });

  it("sends cheap findings back without a sandbox run", async () => {
    const { check, requests } = checking(ran(step("install", true)));

    const problems = await check.check({
      profile: REACT_NODE,
      side: "frontend",
      files: withFile("src/App.test.tsx", "jest.fn();\n"),
    });

    expect(problems).toContain("src/App.test.tsx:1: The tests run on Vitest");
    expect(requests).toEqual([]);
  });

  // The sandbox cannot say anything about the code: the Test Run will.
  it("lets the answer stand when the sandbox fails, and says so", async () => {
    const down = checking(new Error("sandbox API down"));
    const broken = checking({
      status: "broken",
      problem: "no result line",
      evidence,
    });
    const input = {
      profile: REACT_NODE,
      side: "backend" as const,
      files: template,
    };

    expect(await down.check.check(input)).toBeNull();
    expect(down.problems).toEqual([
      "The backend could not check its work: sandbox API down",
    ]);
    expect(await broken.check.check(input)).toBeNull();
  });
});
