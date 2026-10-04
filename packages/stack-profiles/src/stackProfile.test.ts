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

describe("writablePaths", () => {
  it("names folders and files the template has, and keeps the test script the profile's", () => {
    for (const profile of STACK_PROFILES) {
      const paths = templateFiles(profile).map((file) => file.path);
      for (const writable of Object.values(profile.writablePaths).flat())
        expect(
          paths.some((path) =>
            writable.endsWith("/")
              ? path.startsWith(writable)
              : path === writable,
          ),
          writable,
        ).toBe(true);
      expect(Object.values(profile.writablePaths).flat()).not.toContain(
        "scripts/",
      );
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
        "src/screens/HealthScreen.tsx",
        "src/screens/HealthScreen.test.tsx",
        "src/api.ts",
        "scripts/sdlcTest.mjs",
      ]),
    );
  });

  // Seen live: without this, renders stacked up and every query by role found
  // two elements, and the Coding Agent rewrote a correct screen three times.
  it("unmounts a screen after each test, which Vitest does not do on its own", () => {
    const setup = files.find((file) => file.path === "src/testSetup.ts")!;

    expect(setup.contents).toContain(
      'import { cleanup } from "@testing-library/react"',
    );
    expect(setup.contents).toContain("afterEach(cleanup)");
    const config = files.find((file) => file.path === "vite.config.ts")!;
    expect(config.contents).toContain("./src/testSetup.ts");
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

// The facts are prompts; these tests are what keeps them true of the template.
describe("templateFacts (T24d)", () => {
  const files = templateFiles(REACT_NODE);
  const file = (path: string) =>
    files.find((one) => one.path === path)?.contents ?? "";
  const facts = [
    ...REACT_NODE.templateFacts.serves,
    ...Object.values(REACT_NODE.templateFacts.builds).flat(),
  ].join("\n");

  it("gives the /health body the template's own test checks, and no other", () => {
    expect(file("server/app.test.ts")).toContain(
      'toEqual({ status: "ok", database: "up" })',
    );
    expect(facts).toContain(
      '{ "status": "ok" | "degraded", "database": "up" | "down" }',
    );
    expect(facts).not.toMatch(/timestamp/);
  });

  it("names exports the template has, in the files it says", () => {
    const exported = (path: string, name: string) =>
      new RegExp(`^export (async )?(function|const) ${name}\\b`, "m").test(
        file(path),
      );

    expect(exported("server/app.ts", "createApp")).toBe(true);
    expect(exported("server/app.ts", "route")).toBe(true);
    expect(exported("server/prisma.ts", "prisma")).toBe(true);
    expect(exported("src/api.ts", "getJson")).toBe(true);
    expect(exported("src/api.ts", "sendJson")).toBe(true);
    expect(exported("src/api.ts", "getHealth")).toBe(true);
  });

  // T25b: the facts tell the frontend to use these; they must be there.
  it("names the screen-test helpers the template ships, and ships them", () => {
    const helpers = file("src/testing/screens.tsx");
    const example = file("src/testing/screenTests.example.test.tsx");

    const stubbing = file("src/testing/stubApi.ts");
    for (const [name, source] of [
      ["stubApi", stubbing],
      ["stubConfirm", stubbing],
      ["expectUnstubbed", stubbing],
      ["renderRoute", helpers],
      ["renderApp", helpers],
      ["currentPath", helpers],
      ["typeInto", helpers],
      ["press", helpers],
      ["follow", helpers],
    ] as const) {
      // expectUnstubbed is for the example's tests; the facts name the rest.
      if (name !== "expectUnstubbed") expect(facts).toContain(name);
      expect(source).toMatch(new RegExp(`^export function ${name}\\b`, "m"));
      // The example shows each one in use, and screens.tsx hands it on.
      expect(example).toContain(name);
      if (source === stubbing) expect(helpers).toContain(name);
    }
    expect(file("src/testSetup.ts")).toContain("verifyStubs()");
    expect(file("src/testSetup.ts")).toContain("vi.unstubAllGlobals()");
  });

  it("names files and tests the template ships", () => {
    for (const path of facts.match(/\b(?:server|src)\/[\w./]+\.tsx?\b/g) ?? [])
      expect(files.map((one) => one.path)).toContain(path);
  });

  it("gives the versions and the test runner the template declares", () => {
    const manifest = JSON.parse(file("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const major = (name: string) =>
      (manifest.dependencies[name] ?? manifest.devDependencies[name])!.match(
        /\d+/,
      )![0];
    const versions: Array<[string, string]> = [
      ["React", "react"],
      ["react-router-dom", "react-router-dom"],
      ["Vite", "vite"],
      ["Tailwind", "tailwindcss"],
      ["Express", "express"],
      ["Prisma", "prisma"],
      ["zod", "zod"],
      ["TypeScript", "typescript"],
      ["Vitest", "vitest"],
    ];

    for (const [label, name] of versions)
      expect(facts).toContain(`${label} ${major(name)}`);
    expect(file("vite.config.ts")).not.toMatch(/globals:\s*true/);
    // Without the types either, a test that forgets its import fails tsc too.
    expect(file("tsconfig.json")).not.toContain("vitest/globals");
    expect(file("prisma/schema.prisma")).toMatch(/provider = "sqlite"/);
  });

  // The T24d spec review: every fact, not some, is checked here.
  it("gives the error answers the template's own tests check", () => {
    const tests = file("server/app.test.ts");

    expect(tests).toContain('toEqual({ error: "Internal Server Error" })');
    expect(tests).toContain('toEqual({ error: "Bad Request" })');
    expect(tests).toMatch(/get\("\/nope"\)[\s\S]*toBe\(404\)/);
    expect(file("server/app.ts")).toContain(
      'status(database === "up" ? 200 : 503)',
    );
    expect(facts).toContain('{ "error": "Internal Server Error" }');
    expect(facts).toContain('{ "error": "Bad Request" }');
  });

  it("gives the /api proxy and how the app and its tests are wired", () => {
    const vite = file("vite.config.ts");

    expect(vite).toContain('"/api"');
    expect(vite).toContain('path.replace(/^\\/api/, "")');
    expect(file("src/api.ts")).toContain("fetch(`/api${path}`)");
    expect(vite).toMatch(/environment: "jsdom"[\s\S]*src\/\*\*\/\*\.test\.tsx/);
    expect(vite).toMatch(
      /environment: "node"[\s\S]*server\/\*\*\/\*\.test\.ts/,
    );
    expect(vite).toContain('setupFiles: ["./src/testSetup.ts"]');
    expect(file("server/app.test.ts")).toContain('from "supertest"');
    expect(file("src/App.test.tsx")).toContain("<MemoryRouter");
    expect(file("src/main.tsx")).toContain("<BrowserRouter>");
    expect(file("src/screens/HealthScreen.test.tsx")).toContain(
      'vi.stubGlobal(\n    "fetch"',
    );
    expect(file("server/app.ts")).toContain(
      "export function createApp(register?: (app: Express) => void): Express",
    );
    expect(file("server/main.ts")).toMatch(/createApp\(.*\)\.listen/);
  });

  // T24j: each side checks its own work with the template's script.
  it("gives each side a check the test script runs: typecheck and its own tests", () => {
    const script = file("scripts/sdlcTest.mjs");
    const vite = file("vite.config.ts");

    expect(REACT_NODE.checkCommand).toEqual({
      backend: "node scripts/sdlcTest.mjs --check backend",
      frontend: "node scripts/sdlcTest.mjs --check frontend",
    });
    expect(script).toContain(
      'const CHECK_PROJECT = { backend: "api", frontend: "screens" };',
    );
    expect(script).toContain('step("typecheck"');
    expect(vite).toContain('name: "api"');
    expect(vite).toContain('name: "screens"');
  });

  it("gives the TypeScript settings and the shared test database", () => {
    const tsconfig = file("tsconfig.json");

    expect(tsconfig).toContain('"strict": true');
    expect(tsconfig).toContain('"verbatimModuleSyntax": true');
    expect(tsconfig).toContain('"noUncheckedIndexedAccess": true');
    const script = file("scripts/sdlcTest.mjs");
    expect(script).toContain('"file:./sdlc-test.db"');
    expect(script).toContain('"--accept-data-loss"');
    expect(script).not.toMatch(/migrate (dev|deploy)/);
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
      "LINT",
      "REUSE",
      "SEC",
      "STRUCT",
      "TEST",
    ]);
  });

  it("blocks on the rules that must never ship", () => {
    const blocking = BASELINE_RULES.filter(isBlocking).map((rule) => rule.id);

    // A linter error and code that does not compile never ship either (T19).
    expect(blocking).toEqual([
      "LINT-01",
      "LINT-03",
      "STRUCT-03",
      "TEST-01",
      "SEC-01",
      "SEC-02",
    ]);
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
