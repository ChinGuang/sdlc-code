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
      "The screens call the API under /api, which the dev server proxies to the API without the prefix: the API Contract's paths have no /api prefix.",
      "Data lives in SQLite through Prisma.",
    ],
    builds: {
      both: [
        "Stack: React 19, react-router-dom 7, Vite 6, Tailwind 3; Express 4, Prisma 6 on SQLite, zod 3; TypeScript 5 as ES modules, so a relative import ends in .js.",
        'Tests run on Vitest 3 without globals: every test file imports what it uses (describe, it, expect, vi, beforeEach, afterEach) from "vitest". Never Jest: no jest.mock, jest.fn or jest.Mock.',
        "server/app.test.ts, src/App.test.tsx and src/screens/HealthScreen.test.tsx are the template's tests: add to them, and keep what they check passing.",
      ],
      backend: [
        "API tests (server/**/*.test.ts) run in Node with supertest against createApp().",
        "SQLite has no Prisma native types: never write @db.VarChar, @db.Text or any @db.* attribute; use String, Int, Float, Boolean and DateTime.",
        "server/app.ts is the template's: extend it, never replace it. It exports createApp(register?), which mounts GET /health, calls register(app) for a Slice's routes and then the error handler, and route(handler), which hands a rejected promise to that handler. Keep both exports as they are; put a Slice's routes in their own file and pass them to createApp in server/main.ts.",
        "server/prisma.ts exports the one PrismaClient (prisma): import it, never create another.",
      ],
      frontend: [
        'Screen tests (src/**/*.test.tsx) run in jsdom with Testing Library, its matchers loaded by src/testSetup.ts. Stub the API with vi.stubGlobal("fetch", …) as src/screens/HealthScreen.test.tsx does, and render a routed screen inside a MemoryRouter as src/App.test.tsx does.',
        "src/api.ts is the only way the screens talk to the API: add functions beside getJson and getHealth, and keep both.",
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
