/**
 * Records what real Test Runs print, as fixtures for the Testing Agent's
 * parser (T16): a passing Slice, failing unit tests on both sides, a failing
 * smoke test and an API that crashes on boot. Spends a little sandbox credit.
 *
 *   pnpm --filter @sdlc-code/core fixtures:testing
 */
import { NebiusSandboxClient } from "@sdlc-code/clients";
import {
  REACT_NODE,
  templateFiles,
  type TemplateFile,
} from "@sdlc-code/stack-profiles";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireEnv } from "../../clients/scripts/requireEnv.js";
import { openDatabase } from "../src/persistence/database.js";
import { SqliteSnapshotStore } from "../src/persistence/snapshotStore.js";
import { SandboxBaseSnapshots } from "../src/testRuns/baseSnapshots.js";
import type { UploadCache } from "../src/testRuns/sandboxFiles.js";
import { SandboxTestRunner } from "../src/testRuns/testRunner.js";

const OUT = join(import.meta.dirname, "../src/agents/testing/fixtures");

const template = templateFiles(REACT_NODE);
const withFiles = (changes: TemplateFile[]): TemplateFile[] => [
  ...template.filter((file) => !changes.some((c) => c.path === file.path)),
  ...changes,
];
const original = (path: string): string =>
  template.find((file) => file.path === path)!.contents;

const SCENARIOS: Record<string, TemplateFile[]> = {
  passing: template,
  // One failing test on each side, so the owner of each can be told apart.
  failingUnit: withFiles([
    {
      path: "server/todos.test.ts",
      contents: [
        'import request from "supertest";',
        'import { describe, expect, it } from "vitest";',
        'import { createApp } from "./app.js";',
        "",
        'describe("POST /todos", () => {',
        '  it("rejects an empty title", async () => {',
        '    const response = await request(createApp()).post("/todos").send({ title: "" });',
        "",
        "    expect(response.status).toBe(400);",
        "  });",
        "});",
        "",
      ].join("\n"),
    },
    {
      path: "src/TodoList.test.tsx",
      contents: [
        'import { render, screen } from "@testing-library/react";',
        'import { describe, expect, it } from "vitest";',
        'import { App } from "./App.js";',
        "",
        'describe("TodoList", () => {',
        '  it("shows the empty state", () => {',
        "    render(<App />);",
        "",
        '    expect(screen.getByText("No todos yet")).toBeInTheDocument();',
        "  });",
        "});",
        "",
      ].join("\n"),
    },
  ]),
  // Unit tests pass, but the running API answers 200 for every route.
  failingSmoke: withFiles([
    {
      path: "server/main.ts",
      contents: original("server/main.ts").replace(
        "createApp()",
        "createApp((app) => app.use((_request, response) => response.json({ ok: true })))",
      ),
    },
  ]),
  // Unit tests pass, but the API throws before it listens.
  crashOnBoot: withFiles([
    {
      path: "server/main.ts",
      contents: `throw new Error("SESSION_SECRET is not set");\n${original("server/main.ts")}`,
    },
  ]),
};

const sandbox = new NebiusSandboxClient({
  token: requireEnv("NEBIUS_API_KEY"),
  project: requireEnv("NEBIUS_AI_PROJECT"),
  baseUrl: process.env.NEBIUS_SANDBOX_URL || undefined,
});
const uploaded: UploadCache = new Map();
const runner = new SandboxTestRunner({
  sandbox,
  snapshots: new SandboxBaseSnapshots({
    sandbox,
    store: new SqliteSnapshotStore({
      db: openDatabase(join(tmpdir(), "sdlc-code-live-snapshots.db")),
    }),
    uploaded,
  }),
  uploaded,
});

mkdirSync(OUT, { recursive: true });
for (const [name, files] of Object.entries(SCENARIOS)) {
  const outcome = await runner.runTests({ profile: REACT_NODE, files });
  writeFileSync(join(OUT, `${name}.log`), outcome.evidence.log);
  console.log(
    `${name}: ${outcome.status}, exit ${outcome.evidence.exitCode}, ${outcome.evidence.log.length} chars`,
  );
}
