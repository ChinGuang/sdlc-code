/**
 * The Stack Profile's test script. It runs in the sandbox (or locally) and
 * prints human-readable progress, then one machine-readable line:
 *
 *   SDLC_RESULT {"profile":"react-node","passed":true,"steps":[…]}
 *
 * Steps: install → unit tests → boot the API → smoke tests → stop.
 * A failing step stops the run; the script always prints its result and exits
 * 0 on success, 1 on failure.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PROFILE = "react-node";
const RESULT_MARKER = "SDLC_RESULT ";
const PORT = Number(process.env.PORT ?? 3100);
const BOOT_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL = 2000;

const steps = [];
const startedAt = Date.now();

/** Runs a command to completion, capturing its output. */
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: process.platform === "win32",
      env: { ...process.env, ...options.env },
    });
    let output = "";
    const collect = (chunk) => {
      output += chunk;
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => resolve({ code: 1, output: String(error) }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

async function step(name, work) {
  const started = Date.now();
  process.stdout.write(`\n=== ${name} ===\n`);
  const { ok, output } = await work();
  const durationMs = Date.now() - started;
  steps.push({ name, ok, durationMs, output: output.slice(-OUTPUT_TAIL) });
  process.stdout.write(`${ok ? "ok" : "FAILED"} in ${durationMs}ms\n`);
  return ok;
}

const asStep = async (command, args, options) => {
  const { code, output } = await run(command, args, options);
  process.stdout.write(output);
  return { ok: code === 0, output };
};

/** Waits for the API to answer, so the smoke tests do not race the boot. */
async function waitForHealth(deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return { ok: true, body: await response.json() };
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  return { ok: false, body: null };
}

let server;
let passed = true;

try {
  if (!existsSync("node_modules")) {
    passed = await step("install", () => asStep("npm", ["install", "--no-audit", "--no-fund"]));
  } else {
    steps.push({ name: "install", ok: true, durationMs: 0, output: "node_modules present" });
  }

  if (passed)
    passed = await step("unit", async () => {
      // npm install leaves a stub client, so this always runs. It rewrites the
      // query engine, which is why the script waits for the API to exit first.
      const generated = await asStep("npx", ["prisma", "generate"]);
      if (!generated.ok) return generated;
      const pushed = await asStep("npx", ["prisma", "db", "push", "--skip-generate"], {
        env: { DATABASE_URL: process.env.DATABASE_URL ?? "file:./dev.db" },
      });
      if (!pushed.ok) return pushed;
      return asStep("npx", ["vitest", "run"], {
        env: { DATABASE_URL: process.env.DATABASE_URL ?? "file:./dev.db" },
      });
    });

  if (passed)
    passed = await step("boot", async () => {
      server = spawn("npx", ["tsx", "server/main.ts"], {
        shell: process.platform === "win32",
        env: {
          ...process.env,
          PORT: String(PORT),
          DATABASE_URL: process.env.DATABASE_URL ?? "file:./dev.db",
        },
      });
      let output = "";
      server.stdout.on("data", (chunk) => (output += chunk));
      server.stderr.on("data", (chunk) => (output += chunk));
      const health = await waitForHealth(Date.now() + BOOT_TIMEOUT_MS);
      return {
        ok: health.ok,
        output: health.ok ? output : `${output}\nThe API did not answer on port ${PORT}.`,
      };
    });

  if (passed)
    passed = await step("smoke", async () => {
      const checks = [];
      const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((response) =>
        response.json(),
      );
      checks.push(`GET /health -> ${JSON.stringify(health)}`);
      const ok = health.status === "ok" && health.database === "up";
      const missing = await fetch(`http://127.0.0.1:${PORT}/definitely-not-here`);
      checks.push(`GET /definitely-not-here -> ${missing.status}`);
      return { ok: ok && missing.status === 404, output: checks.join("\n") };
    });
} catch (error) {
  steps.push({
    name: "script",
    ok: false,
    durationMs: 0,
    output: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  passed = false;
} finally {
  await step("stop", async () => {
    if (!server || server.exitCode !== null) return { ok: true, output: "no server to stop" };
    server.kill();
    // Wait for the child to go: exiting while it closes crashes Node on Windows.
    const exited = await Promise.race([once(server, "exit"), sleep(5000).then(() => null)]);
    return { ok: true, output: exited ? "server stopped" : "server did not stop in 5s" };
  });
}

const result = {
  profile: PROFILE,
  passed: passed && steps.every((step) => step.ok),
  steps,
  durationMs: Date.now() - startedAt,
};
process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result)}\n`);
// Let Node exit on its own: forcing it while a child closes crashes on Windows.
process.exitCode = result.passed ? 0 : 1;
