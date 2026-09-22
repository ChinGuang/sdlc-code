import { describe, expect, it } from "vitest";
import {
  BASELINE_RULES,
  isBlocking,
  ruleProblems,
  type Rule,
} from "./reviewStandard.js";
import {
  REACT_NODE,
  STACK_PROFILES,
  stackProfile,
  templateFiles,
} from "./stackProfile.js";
import { parseTestScriptOutput, RESULT_MARKER } from "./testScriptResult.js";

describe("stackProfile", () => {
  it("finds a profile by id", () => {
    expect(stackProfile("react-node")).toBe(REACT_NODE);
  });

  it("names the profiles that exist when asked for another", () => {
    expect(() => stackProfile("django")).toThrow(
      'Unknown Stack Profile "django"; available: react-node.',
    );
  });

  it("describes the stack for the System Design Agent", () => {
    for (const profile of STACK_PROFILES) {
      expect(profile.summary).toMatch(/\w/);
      expect(profile.testCommand).toMatch(/\w/);
      expect(profile.snapshotCommand).toMatch(/\w/);
    }
  });
});

describe("templateFiles", () => {
  const files = templateFiles(REACT_NODE);
  const paths = files.map((file) => file.path);

  it("ships the application a Walking Skeleton needs", () => {
    expect(paths).toEqual(
      expect.arrayContaining([
        "package.json",
        "index.html",
        "tsconfig.json",
        "vite.config.ts",
        "prisma/schema.prisma",
        "server/app.ts",
        "server/app.test.ts",
        "server/main.ts",
        "src/App.tsx",
        "src/App.test.tsx",
        "src/api.ts",
        "scripts/sdlcTest.mjs",
      ]),
    );
  });

  it("uses repo-relative paths with forward slashes, and no build output", () => {
    for (const path of paths) {
      expect(path.startsWith("/")).toBe(false);
      expect(path).not.toContain("\\");
      expect(path).not.toMatch(/(^|\/)(node_modules|dist)(\/|$)/);
    }
  });

  it("declares the scripts the test script and the agents use", () => {
    const manifest = JSON.parse(
      files.find((file) => file.path === "package.json")!.contents,
    ) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };

    expect(manifest.scripts).toMatchObject({
      test: expect.stringContaining("vitest"),
      build: expect.stringContaining("vite build"),
      start: expect.stringContaining("server/main.ts"),
      "sdlc:test": expect.stringContaining("sdlcTest.mjs"),
    });
    expect(Object.keys(manifest.dependencies)).toEqual(
      expect.arrayContaining(["@prisma/client", "express", "react"]),
    );
  });

  it("serves GET /health from the template, as the Walking Skeleton requires", () => {
    const app = files.find((file) => file.path === "server/app.ts")!.contents;

    expect(app).toContain('"/health"');
    expect(app).toContain('database === "up"');
  });

  it("keeps secrets out of the template (SEC-01)", () => {
    for (const file of files)
      expect(file.contents).not.toMatch(
        /(api[_-]?key|secret|password)\s*[:=]\s*["'][^"']{8,}/i,
      );
  });
});

describe("BASELINE_RULES", () => {
  it("is a usable standard: unique, well-formed ids and descriptions", () => {
    expect(ruleProblems(BASELINE_RULES)).toEqual([]);
  });

  it("covers every family", () => {
    const families = new Set(
      BASELINE_RULES.map((rule) => rule.id.split("-")[0]),
    );

    expect([...families].sort()).toEqual([
      "CLEAN",
      "REUSE",
      "SEC",
      "STRUCT",
      "TEST",
    ]);
  });

  it("blocks on the rules that must never ship", () => {
    const blocking = BASELINE_RULES.filter(isBlocking).map((rule) => rule.id);

    expect(blocking).toEqual(["STRUCT-03", "TEST-01", "SEC-01", "SEC-02"]);
  });

  it("reports duplicate, malformed and empty rules", () => {
    const rules: Rule[] = [
      { id: "SEC-01", description: "a", severity: "blocking" },
      { id: "SEC-01", description: "b", severity: "minor" },
      { id: "nope", description: "c", severity: "minor" },
      { id: "TEST-09", description: "  ", severity: "minor" },
    ];

    expect(ruleProblems(rules)).toEqual([
      "Rule SEC-01 is defined twice.",
      'Rule id "nope" must be a family and number, e.g. "SEC-01".',
      "Rule TEST-09 has no description.",
    ]);
  });
});

describe("parseTestScriptOutput", () => {
  const result = {
    profile: "react-node",
    passed: true,
    steps: [
      {
        name: "unit" as const,
        ok: true,
        durationMs: 12,
        output: "2 passed",
        failures: [],
      },
    ],
    durationMs: 1200,
  };
  const line = `${RESULT_MARKER}${JSON.stringify(result)}`;

  it("reads the result from noisy output", () => {
    const output = ["npm warn deprecated", "=== unit ===", line, ""].join("\n");

    expect(parseTestScriptOutput(output)).toEqual({ result });
  });

  it("takes the last result when a script was retried", () => {
    const second = { ...result, passed: false };
    const output = [line, `${RESULT_MARKER}${JSON.stringify(second)}`].join(
      "\n",
    );

    expect(parseTestScriptOutput(output)).toEqual({ result: second });
  });

  it("reports a script that never finished", () => {
    expect(parseTestScriptOutput("install failed\n")).toEqual({
      problem:
        "The test script printed no SDLC_RESULT line; it did not finish.",
    });
  });

  it("reports a malformed result", () => {
    expect(parseTestScriptOutput(`${RESULT_MARKER}{"profile":`)).toMatchObject({
      problem: expect.stringContaining("not valid JSON"),
    });
    expect(
      parseTestScriptOutput(`${RESULT_MARKER}{"profile":"x","passed":true}`),
    ).toMatchObject({ problem: expect.stringContaining("steps") });
  });
});
