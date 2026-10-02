/**
 * The Stack Profile's lint script. It runs in the sandbox (or locally) and
 * prints human-readable progress, then one machine-readable line:
 *
 *   SDLC_LINT {"profile":"react-node","checks":[…],"problems":[…]}
 *
 * Checks: ESLint over the application, then the TypeScript compiler. Each
 * problem carries the file, the line, the tool's own rule name and the message,
 * which is what a Finding needs (T19). Exit code 0 means nothing was found that
 * either tool calls an error.
 *
 * It never installs anything: the Base Snapshot has the dependencies. It
 * only generates the Prisma client from the application's own schema.
 */
import { spawn } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE = "react-node";
const RESULT_MARKER = "SDLC_LINT ";
const CHECK_TIMEOUT_MS = 300_000;
const OUTPUT_TAIL = 2000;

// Run from the application's root whatever the caller's directory is.
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(appDir);

/** Kills a process and everything it started; a shell child is not enough. */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * Runs a command to completion, capturing output, bounded by a timeout. npx
 * starts the real tool as a child of its own, so the timeout kills the whole
 * group: killing the wrapper alone would leave eslint or tsc running, which is
 * the hang the timeout exists for (sdlcTest.mjs does the same).
 */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
      env: process.env,
      // No stdin: a tool that asks a question must fail, not wait for ever.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      killTree(child);
      err += `\nTimed out after ${CHECK_TIMEOUT_MS / 1000}s.`;
    }, CHECK_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, out, err: `${err}${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out, err });
    });
  });
}

const tail = (text) =>
  text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text;
const appPath = (file) =>
  (file.startsWith(appDir) ? relative(appDir, file) : file)
    .split("\\")
    .join("/");

const checks = [];
const problems = [];

/** ESLint's JSON report, which carries a rule name per problem. */
async function eslintCheck() {
  const started = Date.now();
  const { code, out, err } = await run("npx", [
    "eslint",
    ".",
    "--format",
    "json",
  ]);
  let files = [];
  try {
    files = JSON.parse(out.slice(out.indexOf("[")));
  } catch {
    // No parsable report: the tool itself failed, which is the problem.
    checks.push({
      name: "eslint",
      ok: false,
      durationMs: Date.now() - started,
      output: tail(`${out}${err}`) || "ESLint printed no report.",
    });
    return;
  }
  for (const file of files)
    for (const message of file.messages ?? [])
      problems.push({
        tool: "eslint",
        // ESLint severity 2 is an error, 1 a warning.
        severity: message.severity === 2 ? "error" : "warning",
        file: appPath(file.filePath ?? ""),
        line: message.line ?? 0,
        rule: message.ruleId ?? "eslint",
        message: message.message ?? "",
      });
  checks.push({
    name: "eslint",
    ok: code === 0,
    durationMs: Date.now() - started,
    output: tail(err),
  });
}

/** The TypeScript compiler: every diagnostic is an error. */
async function typeCheck() {
  const started = Date.now();
  // The lint runs on a fresh Base Snapshot, whose Prisma client is the
  // template's: without generating it from this schema, every model a Slice
  // added reads as missing (found in T25: 14 false blocking Findings).
  const generated = await run("npx", ["prisma", "generate"]);
  if (generated.code !== 0) {
    checks.push({
      name: "tsc",
      ok: false,
      durationMs: Date.now() - started,
      output: tail(`${generated.out}${generated.err}`),
    });
    return;
  }
  const { code, out, err } = await run("npx", [
    "tsc",
    "--noEmit",
    "-p",
    "tsconfig.json",
  ]);
  const text = `${out}${err}`;
  // "src/App.tsx(12,7): error TS2322: Type 'x' is not assignable…"
  const diagnostic = /^(.+?)\((\d+),\d+\): error (TS\d+): (.+)$/;
  for (const line of text.split(/\r?\n/)) {
    const match = diagnostic.exec(line.trim());
    if (!match) continue;
    problems.push({
      tool: "tsc",
      severity: "error",
      file: appPath(match[1]),
      line: Number(match[2]),
      rule: match[3],
      message: match[4],
    });
  }
  checks.push({
    name: "tsc",
    ok: code === 0,
    durationMs: Date.now() - started,
    output: tail(text),
  });
}

const startedAt = Date.now();
for (const check of [eslintCheck, typeCheck]) {
  await check();
  const last = checks.at(-1);
  console.log(`${last.ok ? "ok" : "FAILED"} ${last.name}`);
}

const result = {
  profile: PROFILE,
  checks,
  problems,
  durationMs: Date.now() - startedAt,
};
process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result)}\n`);
process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
