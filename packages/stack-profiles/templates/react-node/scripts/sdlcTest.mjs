/**
 * The Stack Profile's test script. It runs in the sandbox (or locally) and
 * prints human-readable progress, then one machine-readable line:
 *
 *   SDLC_RESULT {"profile":"react-node","passed":true,"steps":[…]}
 *
 * Steps: install → unit tests → boot the API → smoke tests → browser tests
 * (e2e) → stop. Install also fetches the browser the e2e step drives.
 * `--install-only` stops after install: it builds a Base Snapshot, with the
 * browser and its system libraries in it (the only run that needs root).
 * `--check <side>` installs, typechecks and runs that side's tests (T24j).
 * Every step is bounded by a timeout, a failing step stops the run, and the
 * script always prints its result. Exit code 0 means every step passed.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PROFILE = "react-node";
const RESULT_MARKER = "SDLC_RESULT ";
const PORT = Number(process.env.PORT ?? 3100);
/** Tests and smoke checks share a database of their own, never the dev one. */
const DATABASE_URL = process.env.DATABASE_URL ?? "file:./sdlc-test.db";
const BOOT_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = {
  install: 600_000,
  // The browser is a ~115 MB download: with npm install it stays inside the
  // Base Snapshot build's 900 s.
  browser: 240_000,
  typecheck: 300_000,
  unit: 600_000,
  e2e: 240_000,
};
const DEFAULT_STEP_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL = 2000;
const VITEST_REPORT = ".sdlc/vitest.json";
/** Written by Playwright's json reporter (playwright.config.ts). */
const PLAYWRIGHT_REPORT = ".sdlc/playwright.json";
/** What node_modules was installed from; install again when it changes. */
const INSTALL_STAMP = "node_modules/.sdlc-installed";
const INSTALL_ONLY = process.argv.includes("--install-only");
/**
 * `--check backend|frontend`: a Coding Agent's own check before its Step ends
 * (T24j). Install, typecheck, and that side's tests only: no API is booted.
 */
const CHECKING = process.argv.includes("--check");
const CHECK = CHECKING
  ? process.argv[process.argv.indexOf("--check") + 1]
  : undefined;
if (CHECKING && CHECK !== "backend" && CHECK !== "frontend") {
  process.stderr.write("--check needs backend or frontend\n");
  process.exit(2);
}
/** Each side's tests, by the Vitest project they run in (vite.config.ts). */
const CHECK_PROJECT = { backend: "api", frontend: "screens" };

// Run from the application's root whatever the caller's directory is.
process.chdir(join(dirname(fileURLToPath(import.meta.url)), ".."));

const steps = [];
const startedAt = Date.now();
const childEnv = { ...process.env, DATABASE_URL, PORT: String(PORT) };

/** Kills a process and everything it started; a shell child is not enough. */
async function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGKILL");
    }
  }
  await Promise.race([once(child, "exit"), sleep(5000)]);
}

/** Runs a command to completion, capturing output and bounded by `timeoutMs`. */
function run(command, args, { timeoutMs = DEFAULT_STEP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
      env: childEnv,
      // No stdin: a tool that asks a question must fail, not wait for ever.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk) => {
      output += chunk;
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      output += `\nTimed out after ${timeoutMs}ms.`;
      void killTree(child);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, output: `${output}\nCould not run ${command}: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

const asStep = async (command, args, options) => {
  const { code, output } = await run(command, args, options);
  process.stdout.write(output);
  return { ok: code === 0, output };
};

/** Records one step; a throw inside it fails that step, not the whole script. */
async function step(name, work) {
  const started = Date.now();
  process.stdout.write(`\n=== ${name} ===\n`);
  let outcome;
  try {
    outcome = await work();
  } catch (error) {
    outcome = {
      ok: false,
      output: error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  }
  const durationMs = Date.now() - started;
  steps.push({
    name,
    ok: outcome.ok,
    durationMs,
    output: outcome.output.slice(-OUTPUT_TAIL),
    failures: outcome.failures ?? [],
  });
  process.stdout.write(`${outcome.ok ? "ok" : "FAILED"} in ${durationMs}ms\n`);
  return outcome.ok;
}

/** The manifest the dependencies come from. */
function manifestHash() {
  const hash = createHash("sha256");
  for (const file of ["package.json", "package-lock.json"])
    if (existsSync(file)) hash.update(file).update(readFileSync(file));
  return hash.digest("hex");
}

const portIsFree = () =>
  new Promise((resolve) => {
    const probe = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => probe.close(() => resolve(true)))
      .listen(PORT, "127.0.0.1");
  });

/** The API's own process can outlive its npx parent for a moment. */
async function portFreed(deadline) {
  while (!(await portIsFree())) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  return true;
}

/** Waits for the API to answer, so the smoke tests do not race the boot. */
async function waitForHealth(deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  return false;
}

/**
 * One failure per compiler error, "src/App.tsx(3,10): error TS2304: …", so
 * each names its own file and line and goes to the side that wrote it (T24j).
 */
function tscFailures(output) {
  return output.split("\n").flatMap((line) => {
    const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
    return match
      ? [
          {
            test: `${match[1]}(${match[2]},${match[3]})`,
            file: match[1],
            message: `error ${match[4]}: ${match[5]}`,
          },
        ]
      : [];
  });
}

/** The failing tests vitest reported, for an Issue Report (T16). */
function vitestFailures() {
  if (!existsSync(VITEST_REPORT)) return [];
  try {
    const report = JSON.parse(readFileSync(VITEST_REPORT, "utf8"));
    return (report.testResults ?? []).flatMap((file) =>
      (file.assertionResults ?? [])
        .filter((test) => test.status === "failed")
        .map((test) => ({
          test: [...(test.ancestorTitles ?? []), test.title].join(" > "),
          file: file.name ?? "",
          message: (test.failureMessages ?? []).join("\n").slice(0, 1000),
        })),
    );
  } catch {
    return [];
  }
}

/** The failing browser tests Playwright reported, for an Issue Report (T16). */
function playwrightFailures() {
  if (!existsSync(PLAYWRIGHT_REPORT)) return [];
  try {
    const report = JSON.parse(readFileSync(PLAYWRIGHT_REPORT, "utf8"));
    const failures = [];
    const visit = (suite, titles) => {
      const path = suite.title ? [...titles, suite.title] : titles;
      for (const spec of suite.specs ?? [])
        for (const test of spec.tests ?? []) {
          const failed = (test.results ?? []).find(
            (result) => result.status !== "passed" && result.status !== "skipped",
          );
          if (!failed) continue;
          failures.push({
            test: [...path, spec.title].join(" > "),
            // Relative to testDir in the report; the application's own path here.
            file: `e2e/${spec.file ?? suite.file ?? ""}`,
            message: (failed.error?.message ?? failed.errors?.[0]?.message ?? "")
              .replace(/\u001b\[[0-9;]*m/g, "")
              .slice(0, 1000),
          });
        }
      for (const child of suite.suites ?? []) visit(child, path);
    };
    // The top-level suites are the spec files; their title is the file's name.
    for (const suite of report.suites ?? []) visit(suite, []);
    return failures;
  } catch {
    return [];
  }
}

let server;
let passed = true;

try {
  // A Base Snapshot has the template's dependencies; a Slice that adds one
  // changes package.json, and only then does npm install run again. The browser
  // the e2e step drives is looked for every time, and is already there unless
  // this is the Base Snapshot build: only that run (--install-only) fetches the
  // browser's system libraries (apt needs root and the network).
  passed = await step("install", async () => {
    const wanted = manifestHash();
    let output = "dependencies already installed from this package.json\n";
    if (!(existsSync(INSTALL_STAMP) && readFileSync(INSTALL_STAMP, "utf8") === wanted)) {
      const installed = await asStep("npm", ["install", "--no-audit", "--no-fund"], {
        timeoutMs: STEP_TIMEOUT_MS.install,
      });
      if (!installed.ok) return installed;
      // Hashed again: the first install writes package-lock.json.
      writeFileSync(INSTALL_STAMP, manifestHash());
      output = installed.output;
    }
    // A Coding Agent's own check never opens a browser.
    if (CHECKING) return { ok: true, output };
    const browser = await asStep(
      "npx",
      [
        "playwright",
        "install",
        ...(INSTALL_ONLY ? ["--with-deps"] : []),
        "--only-shell",
        "chromium",
      ],
      { timeoutMs: STEP_TIMEOUT_MS.browser },
    );
    // Both are cut, so the browser's banner never pushes npm's lines out of
    // the step's output tail.
    return {
      ok: browser.ok,
      output: `${output.slice(-1000)}\n${browser.output.slice(-800)}`,
    };
  });

  // The Prisma client's types come from the schema, so the typecheck needs it.
  if (passed && CHECKING)
    passed = await step("typecheck", async () => {
      const generated = await asStep("npx", ["prisma", "generate"]);
      if (!generated.ok) return generated;
      const checked = await asStep("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], {
        timeoutMs: STEP_TIMEOUT_MS.typecheck,
      });
      return { ...checked, failures: tscFailures(checked.output) };
    });

  if (passed && !INSTALL_ONLY)
    passed = await step("unit", async () => {
      // npm install leaves a stub client, so this runs unless the typecheck
      // just did. It rewrites the query engine, which is why the script waits
      // for the API to exit first.
      if (!CHECKING) {
        const generated = await asStep("npx", ["prisma", "generate"]);
        if (!generated.ok) return generated;
      }
      const pushed = await asStep("npx", [
        "prisma",
        "db",
        "push",
        "--skip-generate",
        "--accept-data-loss",
      ]);
      if (!pushed.ok) return pushed;
      rmSync(VITEST_REPORT, { force: true });
      mkdirSync(dirname(VITEST_REPORT), { recursive: true });
      const tested = await asStep(
        "npx",
        [
          "vitest",
          "run",
          ...(CHECKING ? [`--project=${CHECK_PROJECT[CHECK]}`] : []),
          "--reporter=default",
          "--reporter=json",
          `--outputFile=${VITEST_REPORT}`,
        ],
        { timeoutMs: STEP_TIMEOUT_MS.unit },
      );
      return { ...tested, failures: vitestFailures() };
    });

  if (passed && !INSTALL_ONLY && !CHECKING)
    passed = await step("boot", async () => {
      if (!(await portIsFree()))
        return {
          ok: false,
          output: `Port ${PORT} is already in use; a previous server is still running.`,
        };
      server = spawn("npx", ["tsx", "server/main.ts"], {
        shell: process.platform === "win32",
        detached: process.platform !== "win32",
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const collect = (chunk) => (output += chunk);
      server.stdout.on("data", collect);
      server.stderr.on("data", collect);
      server.on("error", (error) => (output += `\nCould not start the API: ${error.message}`));
      const up = await waitForHealth(Date.now() + BOOT_TIMEOUT_MS);
      return {
        ok: up,
        output: up ? output : `${output}\nThe API did not answer on port ${PORT}.`,
      };
    });

  if (passed && !INSTALL_ONLY && !CHECKING)
    passed = await step("smoke", async () => {
      // One line per check: "ok <request>" or "FAIL <request>: expected …, got …",
      // so a report can name the failing check alone.
      const lines = [];
      const check = (request, pass, expected, got) => {
        lines.push(pass ? `ok ${request}` : `FAIL ${request}: expected ${expected}, got ${got}`);
        return pass;
      };
      const health = await fetch(`http://127.0.0.1:${PORT}/health`);
      const body = await health.json().catch(() => null);
      const healthy = check(
        "GET /health",
        health.status === 200 && body?.status === "ok" && body?.database === "up",
        '200 {"status":"ok","database":"up"}',
        `${health.status} ${JSON.stringify(body)}`,
      );
      const missing = await fetch(`http://127.0.0.1:${PORT}/definitely-not-here`);
      const notFound = check(
        "GET /definitely-not-here",
        missing.status === 404,
        "404",
        String(missing.status),
      );
      return { ok: healthy && notFound, output: lines.join("\n") };
    });

  // The app in a real browser, in front of the API that is already up: the
  // Vite dev server (playwright.config.ts) proxies /api to PORT.
  if (passed && !INSTALL_ONLY && !CHECKING)
    passed = await step("e2e", async () => {
      rmSync(PLAYWRIGHT_REPORT, { force: true });
      mkdirSync(dirname(PLAYWRIGHT_REPORT), { recursive: true });
      const tested = await asStep("npx", ["playwright", "test"], {
        timeoutMs: STEP_TIMEOUT_MS.e2e,
      });
      return { ...tested, failures: playwrightFailures() };
    });
} finally {
  if (!INSTALL_ONLY && !CHECKING)
    await step("stop", async () => {
      await killTree(server);
      // The port must be free again: a survivor would let the next run pass
      // against a stale server.
      const free = await portFreed(Date.now() + 5000);
      return {
        ok: free,
        output: free
          ? "server stopped"
          : `Port ${PORT} is still in use after stopping the API.`,
      };
    });
}

const result = {
  profile: PROFILE,
  passed: steps.every((step) => step.ok),
  steps,
  durationMs: Date.now() - startedAt,
};
process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result)}\n`);
// Let Node exit on its own: forcing it while a child closes crashes on Windows.
process.exitCode = result.passed ? 0 : 1;
