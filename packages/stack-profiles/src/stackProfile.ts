/**
 * A Stack Profile (CONTEXT.md): the starter template a Run builds in, how it is
 * tested, and its baseline Review Standard. One exists at launch.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_RULES, type Rule } from "./reviewStandard.js";

/** The Coding Agents of a Slice; each writes its own part of the application. */
export type CodingSide = "backend" | "frontend";

export type StackProfile = {
  id: string;
  name: string;
  /** One line for the System Design Agent's prompt. */
  summary: string;
  /** Where the template lives in this repo. */
  templateDir: string;
  /** Run in the application's directory; prints the SDLC_RESULT line. */
  testCommand: string;
  /** Run after a Test Run installed; prints the SDLC_LINT line (T19). */
  lintCommand: string;
  /** Run once in the application's directory to build its Base Snapshot. */
  snapshotCommand: string;
  reviewStandard: readonly Rule[];
  /**
   * What each Coding Agent may write: a folder ends with "/", anything else
   * is one file. Both may read everything; the test script is the profile's.
   */
  writablePaths: Record<CodingSide, readonly string[]>;
  /**
   * The template's contract (T24d): what it already is, so a design does not
   * contradict it and a Slice extends it rather than replacing it. Kept here,
   * beside the template, and checked against it by the tests.
   */
  templateFacts: TemplateFacts;
};

export type TemplateFacts = {
  /** For the System Design Agent: what the API already serves. */
  serves: readonly string[];
  /**
   * For the Coding Agents: how the template works, and what to keep. Both
   * are told `both`, and each its own side's.
   */
  builds: Record<"both" | CodingSide, readonly string[]>;
};

const TEMPLATES = fileURLToPath(new URL("../templates/", import.meta.url));

export const REACT_NODE: StackProfile = {
  id: "react-node",
  name: "React + Node",
  summary:
    "React + Vite + Tailwind frontend; Express API with Prisma (SQLite) backend; Vitest for both.",
  templateDir: join(TEMPLATES, "react-node"),
  testCommand: "node scripts/sdlcTest.mjs",
  lintCommand: "node scripts/sdlcLint.mjs",
  snapshotCommand: "node scripts/sdlcTest.mjs --install-only",
  reviewStandard: BASELINE_RULES,
  writablePaths: {
    backend: ["server/", "prisma/", "package.json", ".env.example"],
    frontend: [
      "src/",
      "index.html",
      "package.json",
      "vite.config.ts",
      "tailwind.config.js",
      "postcss.config.js",
    ],
  },
  templateFacts: {
    serves: [
      'GET /health answers exactly { "status": "ok" | "degraded", "database": "up" | "down" }: 200, or 503 when the database is down. The template\'s own test checks this exact body, so the API Contract keeps it as it is and adds no field to it.',
      'A path no route serves answers 404, and a route that throws answers 500 with { "error": "Internal Server Error" } and no detail (SEC-03).',
      'A request body that is not valid JSON answers 400 with { "error": "Bad Request" }, before any route sees it.',
      "The screens call the API under /api, which the dev server proxies to the API without the prefix: the API Contract's paths have no /api prefix.",
      "The database is SQLite through Prisma, which has no native column types such as VARCHAR(200): a length limit belongs in the API's validation, not in the schema.",
    ],
    builds: {
      both: [
        'Stack: React 19, react-router-dom 7, Vite 6, Tailwind 3; Express 4, Prisma 6 on SQLite, zod 3; TypeScript 5 as ES modules. The template writes relative imports with .js ("./app.js"); do the same.',
        'Tests run on Vitest 3 without globals: every test file imports what it uses (describe, it, expect, vi, beforeEach, afterEach) from "vitest". Never Jest: no jest.mock, jest.fn or jest.Mock.',
        "TypeScript is strict, with verbatimModuleSyntax and noUncheckedIndexedAccess: import a type with `import type`, and treat an indexed read (list[0], record[key]) as possibly undefined.",
      ],
      backend: [
        "server/app.test.ts is the template's test: add to it, and keep what it checks passing.",
        "API tests (server/**/*.test.ts) run in Node with supertest against createApp().",
        "The tests and the smoke test share one SQLite database, its schema pushed from prisma/schema.prisma with no migrations: a test creates the rows it reads and never assumes a table is empty.",
        "SQLite has no Prisma native types: never write @db.VarChar, @db.Text or any @db.* attribute; use String, Int, Float, Boolean and DateTime.",
        "server/app.ts is the template's: extend it, never replace it. It exports createApp(register?), which mounts GET /health, calls register(app) for a Slice's routes and then the error handler, and route(handler), which hands a rejected promise to that handler. Keep both exports as they are; put a Slice's routes in their own file and pass them to createApp in server/main.ts.",
        "server/prisma.ts exports the one PrismaClient (prisma): import it, never create another.",
      ],
      frontend: [
        "src/App.test.tsx and src/screens/HealthScreen.test.tsx are the template's tests: add to them, and keep what they check passing.",
        'Screen tests (src/**/*.test.tsx) run in jsdom with Testing Library, its matchers loaded by src/testSetup.ts. Stub the API with vi.stubGlobal("fetch", …) as src/screens/HealthScreen.test.tsx does, and render a routed screen inside a MemoryRouter as src/App.test.tsx does.',
        "src/api.ts is the only way the screens talk to the API: add functions beside getJson and getHealth, and keep both.",
        'getJson(path) adds the /api prefix and only reads: call it with the API Contract\'s path as it is, getJson("/todos"), never "/api/todos". For a write, add a function to src/api.ts that calls fetch(`/api${path}`, …) the same way.',
        "src/App.tsx holds every screen as a <Route>; the Router is in src/main.tsx, so a test renders App inside a MemoryRouter.",
      ],
    },
  },
};

export const STACK_PROFILES: readonly StackProfile[] = [REACT_NODE];

export function stackProfile(id: string): StackProfile {
  const profile = STACK_PROFILES.find((candidate) => candidate.id === id);
  if (!profile)
    throw new Error(
      `Unknown Stack Profile "${id}"; available: ${STACK_PROFILES.map((p) => p.id).join(", ")}.`,
    );
  return profile;
}

export type TemplateFile = { path: string; contents: string };

/** The facts as a prompt section: one fact per line. */
export function factLines(facts: readonly string[]): string {
  return facts.map((fact) => `- ${fact}`).join("\n");
}

/** Never shipped to a generated application, and never built into a Snapshot. */
const SKIPPED = new Set(["node_modules", "dist", ".git", "prisma/dev.db"]);

/**
 * Every file of the template, with repo-relative paths using "/" so they can be
 * uploaded to a sandbox or written into a Workspace as they are.
 */
export function templateFiles(profile: StackProfile): TemplateFile[] {
  const files: TemplateFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      const path = relative(profile.templateDir, full).split(sep).join("/");
      if (SKIPPED.has(entry) || SKIPPED.has(path)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else files.push({ path, contents: readFileSync(full, "utf8") });
    }
  };
  walk(profile.templateDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
