import { SandboxApiError, type SpawnRequest } from "@sdlc-code/clients";
import { REACT_NODE, type TemplateFile } from "@sdlc-code/stack-profiles";
import { describe, expect, it } from "vitest";
import type { BaseSnapshots } from "./baseSnapshots.js";
import {
  fakeSandbox,
  ranOk,
  scriptOutput,
  type FakeSandbox,
} from "./fixtures/fakeSandbox.js";
import { isSecretFile, shellQuote, snapshotHash } from "./sandboxFiles.js";
import {
  planUpload,
  SandboxTestRunner,
  testCommand,
  type TestRunner,
} from "./testRunner.js";

const TEMPLATE: TemplateFile[] = [
  { path: "package.json", contents: "{}" },
  { path: "server/app.ts", contents: "app v1" },
  { path: "src/App.tsx", contents: "screen v1" },
];

const PASSING = scriptOutput([
  { name: "install", ok: true },
  { name: "unit", ok: true },
  { name: "boot", ok: true },
  { name: "smoke", ok: true },
  { name: "stop", ok: true },
]);

function fakeSnapshots(): BaseSnapshots & { discarded: number } {
  const snapshots = {
    discarded: 0,
    snapshotImage: async () => `snapshot-${snapshots.discarded}`,
    discardSnapshot: () => void snapshots.discarded++,
  };
  return snapshots;
}

function setup(onRun?: (request: SpawnRequest) => ReturnType<typeof ranOk>) {
  const sandbox: FakeSandbox = fakeSandbox({
    onRun: onRun ?? (() => ranOk({ stdout: PASSING, resultImage: null })),
  });
  const snapshots = fakeSnapshots();
  // Tests depend on the interface; only this factory knows the class.
  const runner: TestRunner = new SandboxTestRunner({
    sandbox,
    snapshots,
    files: () => TEMPLATE,
  });
  return { runner, sandbox, snapshots };
}

const slice = (changes: TemplateFile[] = []): TemplateFile[] => [
  ...TEMPLATE.filter((file) => !changes.some((c) => c.path === file.path)),
  ...changes,
];

describe("SandboxTestRunner", () => {
  it("starts a disposable run from the Base Snapshot with only the changed files", async () => {
    const { runner, sandbox } = setup();

    await runner.runTests({
      profile: REACT_NODE,
      files: slice([
        { path: "server/app.ts", contents: "app v2" },
        { path: "server/todos.ts", contents: "todos" },
      ]),
    });

    expect(sandbox.runs).toHaveLength(1);
    expect(sandbox.runs[0]).toMatchObject({
      image: "snapshot-0",
      shell: true,
      disposable: true,
      timeout: 1800,
      files: {
        "/app/server/app.ts": { uuid: "file-1" },
        "/app/server/todos.ts": { uuid: "file-2" },
      },
    });
    expect(Object.keys(sandbox.runs[0]!.files!)).toHaveLength(2);
    expect(sandbox.uploads).toEqual(["app v2", "todos"]);
  });

  it("reports a pass with the script's result and the run's evidence", async () => {
    const { runner } = setup();

    const outcome = await runner.runTests({
      profile: REACT_NODE,
      files: slice([{ path: "src/App.tsx", contents: "screen v2" }]),
    });

    expect(outcome.status).toBe("passed");
    expect(outcome).toMatchObject({
      result: { passed: true },
      evidence: {
        operationId: "op-run",
        exitCode: 0,
        timedOut: false,
        cost: 0.001,
        changedFiles: ["src/App.tsx"],
        removedFiles: [],
        withheldFiles: [],
      },
    });
    expect(outcome.evidence.log).toContain("npm chatter");
  });

  it("reports a failure with the failing tests", async () => {
    const { runner } = setup(() =>
      ranOk({
        exitCode: 1,
        stdout: scriptOutput([
          { name: "install", ok: true },
          {
            name: "unit",
            ok: false,
            failures: [
              {
                test: "POST /todos > rejects an empty title",
                file: "server/todos.test.ts",
                message: "expected 400, got 500",
              },
            ],
          },
          { name: "stop", ok: true },
        ]),
      }),
    );

    const outcome = await runner.runTests({
      profile: REACT_NODE,
      files: slice(),
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "broken") throw new Error("unexpected");
    expect(outcome.result.steps[1]!.failures[0]!.test).toBe(
      "POST /todos > rejects an empty title",
    );
  });

  it("reports a broken run when the script never printed its result", async () => {
    const { runner } = setup(() =>
      ranOk({ exitCode: -1, timedOut: true, stdout: "installing…" }),
    );

    const outcome = await runner.runTests({
      profile: REACT_NODE,
      files: slice(),
    });

    expect(outcome).toMatchObject({
      status: "broken",
      problem: expect.stringMatching(/printed no SDLC_RESULT.*timed out/),
      evidence: { timedOut: true, log: "installing…" },
    });
  });

  // Spike T01 finding 1: never trust one signal alone.
  it("does not pass a run whose script passed but whose command failed", async () => {
    const { runner } = setup(() => ranOk({ exitCode: 137, stdout: PASSING }));

    const outcome = await runner.runTests({
      profile: REACT_NODE,
      files: slice(),
    });

    expect(outcome).toMatchObject({
      status: "broken",
      problem: expect.stringMatching(/reported success.*exit code 137/),
    });
  });

  it("deletes template files the application removed", async () => {
    const { runner, sandbox } = setup();

    const outcome = await runner.runTests({
      profile: REACT_NODE,
      files: TEMPLATE.filter((file) => file.path !== "src/App.tsx"),
    });

    expect(outcome.evidence.removedFiles).toEqual(["src/App.tsx"]);
    expect(sandbox.runs[0]!.command).toContain("rm -f -- 'src/App.tsx'");
  });

  it("never sends a secret file into the sandbox", async () => {
    const { runner, sandbox } = setup();

    const outcome = await runner.runTests({
      profile: REACT_NODE,
      files: slice([
        { path: ".env", contents: "NEBIUS_API_KEY=secret-key-123" },
        { path: "server/.env.local", contents: "TOKEN=secret-key-456" },
        { path: ".env.example", contents: "NEBIUS_API_KEY=" },
      ]),
    });

    expect(outcome.evidence.withheldFiles).toEqual([
      ".env",
      "server/.env.local",
    ]);
    const sent = JSON.stringify({
      uploads: sandbox.uploads,
      runs: sandbox.runs,
    });
    expect(sent).not.toContain("secret-key-123");
    expect(sent).not.toContain("secret-key-456");
    expect(sandbox.runs[0]!.files).toHaveProperty("/app/.env.example");
  });

  it("refuses a file path that leaves the application", async () => {
    const { runner, sandbox } = setup();

    for (const path of ["../etc/passwd", "/etc/passwd", "a\\b", "a//b"])
      await expect(
        runner.runTests({
          profile: REACT_NODE,
          files: [{ path, contents: "x" }],
        }),
      ).rejects.toThrow(/Refusing file path/);
    expect(sandbox.runs).toEqual([]);
  });

  it("uploads each content once across Test Runs", async () => {
    const { runner, sandbox } = setup();
    const files = slice([{ path: "server/todos.ts", contents: "todos" }]);

    await runner.runTests({ profile: REACT_NODE, files });
    await runner.runTests({ profile: REACT_NODE, files });

    expect(sandbox.uploads).toEqual(["todos"]);
    expect(sandbox.runs[1]!.files).toEqual(sandbox.runs[0]!.files);
  });

  it("uploads identical content once even within one run", async () => {
    const { runner, sandbox } = setup();

    await runner.runTests({
      profile: REACT_NODE,
      files: slice([
        { path: "server/a.ts", contents: "same" },
        { path: "server/b.ts", contents: "same" },
      ]),
    });

    expect(sandbox.uploads).toEqual(["same"]);
  });

  it("uploads again after a failed upload", async () => {
    const { runner, sandbox } = setup();
    let failNext = true;
    const upload = sandbox.uploadFile;
    sandbox.uploadFile = async (content) => {
      if (failNext) {
        failNext = false;
        throw new SandboxApiError(503, "busy");
      }
      return upload(content);
    };
    const files = slice([{ path: "server/todos.ts", contents: "todos" }]);

    await expect(
      runner.runTests({ profile: REACT_NODE, files }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      runner.runTests({ profile: REACT_NODE, files }),
    ).resolves.toMatchObject({ status: "passed" });
  });

  it("rebuilds the Snapshot and runs again once when the sandbox no longer has it", async () => {
    let attempts = 0;
    const { runner, sandbox, snapshots } = setup(() => {
      if (++attempts === 1) throw new SandboxApiError(404, "image not found");
      return ranOk({ stdout: PASSING });
    });

    const outcome = await runner.runTests({
      profile: REACT_NODE,
      files: slice([{ path: "server/todos.ts", contents: "todos" }]),
    });

    expect(outcome.status).toBe("passed");
    expect(snapshots.discarded).toBe(1);
    expect(sandbox.runs.map((run) => run.image)).toEqual([
      "snapshot-0",
      "snapshot-1",
    ]);
    // Uploaded files may have expired too, so they are sent again.
    expect(sandbox.uploads).toEqual(["todos", "todos"]);
  });

  it("gives up when the sandbox still does not have it after a rebuild", async () => {
    const { runner, snapshots } = setup(() => {
      throw new SandboxApiError(404, "image not found");
    });

    await expect(
      runner.runTests({ profile: REACT_NODE, files: slice() }),
    ).rejects.toMatchObject({ status: 404 });
    expect(snapshots.discarded).toBe(1);
  });

  it("does not rebuild the Snapshot for a bad request or bad credentials", async () => {
    for (const status of [400, 401, 403, 413]) {
      const { runner, snapshots } = setup(() => {
        throw new SandboxApiError(status, "refused");
      });

      await expect(
        runner.runTests({ profile: REACT_NODE, files: slice() }),
      ).rejects.toMatchObject({ status });
      expect(snapshots.discarded).toBe(0);
    }
  });

  it("does not rebuild the Snapshot when the API is failing", async () => {
    const { runner, snapshots } = setup(() => {
      throw new SandboxApiError(503, "busy");
    });

    await expect(
      runner.runTests({ profile: REACT_NODE, files: slice() }),
    ).rejects.toMatchObject({ status: 503 });
    expect(snapshots.discarded).toBe(0);
  });
});

describe("planUpload", () => {
  it("sends nothing for an application identical to the template", () => {
    expect(planUpload(TEMPLATE, TEMPLATE)).toEqual({
      changed: [],
      removed: [],
      withheld: [],
    });
  });
});

describe("testCommand", () => {
  it("keeps the end of the log so the result line survives truncation", () => {
    expect(testCommand(REACT_NODE, [])).toBe(
      "cd '/app' && mkdir -p .sdlc && { node scripts/sdlcTest.mjs > .sdlc/test.log 2>&1; code=$?; tail -c 60000 .sdlc/test.log; exit $code; }",
    );
  });
});

describe("shellQuote", () => {
  it("quotes a word, including single quotes inside it", () => {
    expect(shellQuote("it's here; rm -rf /")).toBe(`'it'"'"'s here; rm -rf /'`);
  });
});

describe("isSecretFile", () => {
  it("withholds .env files but not the example", () => {
    expect(isSecretFile(".env")).toBe(true);
    expect(isSecretFile("server/.env.production")).toBe(true);
    expect(isSecretFile(".env.example")).toBe(false);
    expect(isSecretFile("src/environment.ts")).toBe(false);
  });
});

describe("snapshotHash", () => {
  it("does not depend on file order, but on every input", () => {
    const hash = snapshotHash(TEMPLATE, "install", "node");

    expect(snapshotHash([...TEMPLATE].reverse(), "install", "node")).toBe(hash);
    expect(snapshotHash(TEMPLATE, "install --ci", "node")).not.toBe(hash);
    expect(snapshotHash(TEMPLATE, "install", "node:24")).not.toBe(hash);
    expect(snapshotHash(TEMPLATE.slice(1), "install", "node")).not.toBe(hash);
  });
});
