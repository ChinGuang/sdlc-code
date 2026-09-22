/**
 * Issue Reports (CONTEXT.md): what a Test Run found, as structured failures
 * the Orchestrator routes. Each names the failing test or step, the error,
 * the evidence, a *suspected* owner, and a signature for Loop detection.
 * Built in code from the test script's result: the facts are all there, so no
 * model call is needed to read them.
 */
import { createHash } from "node:crypto";
import type {
  CodingSide,
  StackProfile,
  TestFailure,
  TestStep,
  TestStepName,
} from "@sdlc-code/stack-profiles";
import type { AgentRole } from "../../agentRoles.js";
import { SANDBOX_APP_DIR } from "../../testRuns/sandboxFiles.js";
import type { TestRunOutcome } from "../../testRuns/testRunner.js";
import type { CodingIssue } from "../coding/codingContext.js";
import { HTTP_METHODS } from "../systemDesign/design.js";

/** Only a Coding Agent is ever *suspected*; the Orchestrator decides (T17). */
export type SuspectedOwner = Extract<
  AgentRole,
  "backendCoding" | "frontendCoding"
>;

export type IssueReport = {
  /** The test script step that failed, or "sandbox" when it never finished. */
  step: TestStepName | "sandbox";
  /** Full test name, e.g. "POST /todos > rejects an empty title". */
  failingTest: string | null;
  /** The application file the evidence points at: a failing test's file, or the file a crash names. */
  file: string | null;
  /**
   * The API Contract operation the failure is about, when the evidence names
   * one ("POST /todos"), so the Orchestrator can check the code against the
   * Contract (diagram 7).
   */
  endpoint: string | null;
  /** One line: what went wrong. */
  error: string;
  /** What the Coding Agent needs to see: the failure message or the step's output. */
  evidence: string;
  /** Null when the evidence does not point at one side. */
  suspectedOwner: SuspectedOwner | null;
  /** Equal for the same failure on a later attempt (CONTEXT.md "Loop"). */
  signature: string;
  /** How many failures had this signature in the run, e.g. one error in many tests. */
  occurrences: number;
};

const OWNERS: Record<CodingSide, SuspectedOwner> = {
  backend: "backendCoding",
  frontend: "frontendCoding",
};

/** Evidence is for a model to read; its context is not the place for full logs. */
const MAX_EVIDENCE_CHARS = 1500;
const MAX_ERROR_CHARS = 300;
/** Most Issue Reports a Coding Agent is given at once; the rest follow on the next attempt. */
export const MAX_CODING_ISSUES = 10;

/** "POST /todos > rejects …" or "FAIL GET /x: …": the operation named at the start. */
const LEADING_ENDPOINT = new RegExp(
  String.raw`^(?:FAIL )?((?:${HTTP_METHODS.join("|")}) /[^\s:>]*)`,
);

/** Everything a Test Run found wrong, one report per distinct failure; empty when it passed. */
export function issueReports(
  outcome: TestRunOutcome,
  profile: StackProfile,
): IssueReport[] {
  if (outcome.status === "passed") return [];
  if (outcome.status === "broken")
    return [
      report({
        step: "sandbox",
        failingTest: null,
        file: null,
        endpoint: null,
        error: oneLine(outcome.problem),
        evidence: tail(outcome.evidence.log),
        suspectedOwner: null,
      }),
    ];
  const reports = outcome.result.steps
    .filter((step) => !step.ok)
    .flatMap((step) =>
      step.failures.length > 0
        ? step.failures.map((failure) => fromFailure(step, failure, profile))
        : [fromStep(step, profile)],
    );
  return mergeBySignature(reports);
}

/** An Issue Report matching an earlier one in the same Task (CONTEXT.md "Loop"). */
export function isLoop(
  report: IssueReport,
  earlier: readonly IssueReport[],
): boolean {
  return earlier.some((previous) => previous.signature === report.signature);
}

/** What the Coding Agent that owns a report is told (T15 CodingIssue). */
export function toCodingIssue(report: IssueReport): CodingIssue {
  const where = report.failingTest ?? `${report.step} step`;
  const file = report.file ? ` (${report.file})` : "";
  const more =
    report.occurrences > 1 ? ` [${report.occurrences} failures like this]` : "";
  return {
    summary: `${where}${file}: ${report.error}${more}`,
    evidence: report.evidence,
  };
}

/**
 * The Issue Reports for one Coding Agent, at most MAX_CODING_ISSUES of them:
 * fixing the first often fixes the rest, and every one costs context.
 */
export function codingIssues(reports: readonly IssueReport[]): CodingIssue[] {
  const issues = reports.slice(0, MAX_CODING_ISSUES).map(toCodingIssue);
  const rest = reports.length - MAX_CODING_ISSUES;
  return rest > 0
    ? [
        ...issues,
        {
          summary: `${rest} more failures not listed; fix these first.`,
          evidence: reports
            .slice(MAX_CODING_ISSUES)
            .map(
              (report) =>
                `- ${report.failingTest ?? report.step}: ${report.error}`,
            )
            .join("\n"),
        },
      ]
    : issues;
}

function fromFailure(
  step: TestStep,
  failure: TestFailure,
  profile: StackProfile,
): Draft {
  const file =
    appPath(failure.file) ?? appFileIn(failure.message, profile).file;
  return {
    step: step.name,
    failingTest: failure.test,
    file,
    endpoint: LEADING_ENDPOINT.exec(failure.test)?.[1] ?? null,
    error: oneLine(firstLine(failure.message) ?? `${failure.test} failed`),
    evidence: head(withoutLibraryFrames(failure.message)),
    suspectedOwner: file ? ownerOf(file, profile) : null,
  };
}

/** A step that failed without naming tests: install, boot, smoke, stop, or a unit run that crashed. */
function fromStep(step: TestStep, profile: StackProfile): Draft {
  const lines = stripAnsi(step.output)
    .split("\n")
    .map((line) => line.trim());
  if (step.name === "smoke") {
    const failing = lines.filter((line) => line.startsWith("FAIL "));
    return {
      step: step.name,
      failingTest: null,
      file: null,
      endpoint:
        failing.length === 1
          ? (LEADING_ENDPOINT.exec(failing[0]!)?.[1] ?? null)
          : null,
      error: oneLine(
        failing.length > 0
          ? `Smoke test failed: ${failing.map((line) => line.slice("FAIL ".length)).join("; ")}`
          : "Smoke tests failed.",
      ),
      evidence: tail(step.output),
      // The API's answers are the backend's.
      suspectedOwner: OWNERS.backend,
    };
  }
  const errorAt = lines.findIndex((line) => ERROR_LINE.test(line));
  const { file } = appFileIn(step.output, profile, Math.max(errorAt, 0));
  return {
    step: step.name,
    failingTest: null,
    file,
    endpoint: null,
    error: oneLine(
      errorAt >= 0
        ? lines[errorAt]!
        : (lastMeaningfulLine(lines) ?? `The ${step.name} step failed.`),
    ),
    evidence: tail(withoutLibraryFrames(step.output)),
    suspectedOwner: stepOwner(step.name, file, profile),
  };
}

/** A line that says what broke: "TypeError: …", "npm error …", "error TS2345: …". */
const ERROR_LINE = /^([A-Z]\w*)?Error\b|^npm (ERR|error)!?|error TS\d+/;

/**
 * Lines the test script adds after a step fails, which say that it failed
 * but not why; two different crashes end with the same one.
 */
const SCRIPT_TRAILER =
  /^(The API did not answer on port \d+\.|Port \d+ is (already|still) in use.*|Timed out after \d+ms\.)$/;

function lastMeaningfulLine(lines: readonly string[]): string | null {
  const meaningful = lines.filter(Boolean);
  return (
    meaningful.filter((line) => !SCRIPT_TRAILER.test(line)).at(-1) ??
    meaningful.at(-1) ??
    null
  );
}

/**
 * The API is the backend's: booting and stopping it. Install and a crashed
 * unit run point wherever the evidence does; package.json belongs to both
 * sides, so it points nowhere.
 */
function stepOwner(
  step: TestStepName,
  file: string | null,
  profile: StackProfile,
): SuspectedOwner | null {
  if (step === "boot" || step === "stop") return OWNERS.backend;
  return file ? ownerOf(file, profile) : null;
}

/** The side whose Coding Agent may write `file`, if exactly one may. */
function ownerOf(file: string, profile: StackProfile): SuspectedOwner | null {
  const sides = (Object.keys(profile.writablePaths) as CodingSide[]).filter(
    (side) =>
      profile.writablePaths[side].some((writable) =>
        writable.endsWith("/") ? file.startsWith(writable) : file === writable,
      ),
  );
  return sides.length === 1 ? OWNERS[sides[0]!] : null;
}

/** "/app/server/todos.test.ts" → "server/todos.test.ts"; null outside the application. */
function appPath(path: string): string | null {
  const prefix = `${SANDBOX_APP_DIR}/`;
  const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  if (
    relative === "" ||
    relative.startsWith("/") ||
    relative.startsWith("node_modules/")
  )
    return null;
  return relative;
}

/**
 * The first application file named from line `from` on: a path that starts
 * at an application folder, bare or under /app, never one inside
 * node_modules. Lines the test runner or Prisma print about other tests
 * ("stderr | server/app.test.ts > …", "Prisma schema loaded from …") are
 * skipped, since they name a file that did not fail.
 */
function appFileIn(
  text: string,
  profile: StackProfile,
  from = 0,
): { file: string | null } {
  const folders = [
    ...new Set(
      Object.values(profile.writablePaths)
        .flat()
        .filter((path) => path.endsWith("/")),
    ),
  ];
  const lines = stripAnsi(text).split("\n").slice(from);
  for (const line of lines) {
    if (/^\s*stderr \|/.test(line) || /^\s*Prisma schema loaded/.test(line))
      continue;
    for (const token of line.split(/[\s()'"`]+/)) {
      const path = token
        .replace(/^file:\/\//, "")
        .replace(new RegExp(`^${SANDBOX_APP_DIR}/`), "")
        // "…/App.tsx." ends a sentence; "…/app.ts:9:29" names a line.
        .replace(/[.,;:]+$/, "")
        .replace(/:\d+(:\d+)?$/, "");
      if (
        folders.some((folder) => path.startsWith(folder)) &&
        /\.\w+$/.test(path)
      )
        return { file: path };
    }
  }
  return { file: null };
}

function firstLine(text: string): string | null {
  return (
    stripAnsi(text)
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= MAX_ERROR_CHARS
    ? line
    : `${line.slice(0, MAX_ERROR_CHARS)}…`;
}

/** Stack frames inside node_modules and Node itself say nothing about the application. */
function withoutLibraryFrames(text: string): string {
  return stripAnsi(text)
    .split("\n")
    .filter(
      (line) =>
        !/^\s*(at |❯ ).*(node_modules|node:internal)/.test(line) &&
        !/^\s*at .*\(?node:/.test(line),
    )
    .join("\n")
    .trim();
}

/** The end of a step's output, where it says how it ended. */
function tail(text: string): string {
  const clean = stripAnsi(text).trim();
  return clean.length <= MAX_EVIDENCE_CHARS
    ? clean
    : `…${clean.slice(-MAX_EVIDENCE_CHARS)}`;
}

/** The start of a test's failure: the assertion comes first. */
function head(text: string): string {
  const clean = stripAnsi(text).trim();
  return clean.length <= MAX_EVIDENCE_CHARS
    ? clean
    : `${clean.slice(0, MAX_EVIDENCE_CHARS)}…`;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (text: string): string => text.replace(ANSI, "");

/**
 * What stays the same when the same failure happens again: the error without
 * what varies between runs. Timestamps first, then ids, then timings and line
 * numbers, so one rule never leaves part of another's match behind.
 */
export function normalizeError(error: string): string {
  return (
    stripAnsi(error)
      .replace(
        /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?/g,
        "<timestamp>",
      )
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        "<uuid>",
      )
      // A hex id has a letter in it; a plain number is part of the error.
      .replace(/\b(?=[0-9]*[a-f])[0-9a-f]{8,}\b/gi, "<id>")
      .replace(/\b\d+(\.\d+)?\s?(ms|s)\b/g, "<time>")
      .replace(/:\d+:\d+\b/g, ":<line>")
      .replace(/\s+/g, " ")
      .trim()
  );
}

type Draft = Omit<IssueReport, "signature" | "occurrences">;

function report(draft: Draft): IssueReport {
  // Loop = same failing test (in the same file) and the same error.
  const signature = createHash("sha256")
    .update(
      [
        draft.step,
        draft.failingTest ?? "",
        draft.failingTest ? (draft.file ?? "") : "",
        normalizeError(draft.error),
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 16);
  return { ...draft, signature, occurrences: 1 };
}

/** One report per signature, counting how often it occurred. */
function mergeBySignature(drafts: readonly Draft[]): IssueReport[] {
  const merged = new Map<string, IssueReport>();
  for (const draft of drafts) {
    const next = report(draft);
    const seen = merged.get(next.signature);
    if (seen) seen.occurrences++;
    else merged.set(next.signature, next);
  }
  return [...merged.values()];
}
