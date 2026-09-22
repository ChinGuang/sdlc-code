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
  /** The application file at fault, as far as the evidence shows. */
  file: string | null;
  /** One line: what went wrong. */
  error: string;
  /** What the Coding Agent needs to see: message, code frame, output. */
  evidence: string;
  /** Null when the evidence does not point at one side. */
  suspectedOwner: SuspectedOwner | null;
  /** Equal for the same failure on a later attempt (CONTEXT.md "Loop"). */
  signature: string;
};

const OWNERS: Record<CodingSide, SuspectedOwner> = {
  backend: "backendCoding",
  frontend: "frontendCoding",
};

/** Evidence is for a model to read; its context is not the place for full logs. */
const MAX_EVIDENCE_CHARS = 1500;

/** Everything a Test Run found wrong; empty when it passed. */
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
        error: outcome.problem,
        evidence: tail(outcome.evidence.log),
        suspectedOwner: null,
      }),
    ];
  return outcome.result.steps
    .filter((step) => !step.ok)
    .flatMap((step) =>
      step.failures.length > 0
        ? step.failures.map((failure) => fromFailure(step, failure, profile))
        : [fromStep(step, profile)],
    );
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
  return {
    summary: `${where}${file}: ${report.error}`,
    evidence: report.evidence,
  };
}

function fromFailure(
  step: TestStep,
  failure: TestFailure,
  profile: StackProfile,
): IssueReport {
  const file = appPath(failure.file) ?? firstAppFile(failure.message, profile);
  return report({
    step: step.name,
    failingTest: failure.test,
    file,
    error: firstLine(failure.message) ?? `${failure.test} failed`,
    evidence: head(withoutLibraryFrames(failure.message)),
    suspectedOwner: file ? ownerOf(file, profile) : null,
  });
}

/** A step that failed without naming tests: install, boot, smoke, stop, or a unit run that crashed. */
function fromStep(step: TestStep, profile: StackProfile): IssueReport {
  const file = firstAppFile(step.output, profile);
  return report({
    step: step.name,
    failingTest: null,
    file,
    error: stepError(step),
    evidence: tail(withoutLibraryFrames(step.output)),
    suspectedOwner: stepOwner(step, file, profile),
  });
}

/**
 * The API is the backend's: booting it, its answers to the smoke tests and
 * stopping it. Install and a crashed unit run point wherever the evidence
 * does; package.json belongs to both sides, so it points nowhere.
 */
function stepOwner(
  step: TestStep,
  file: string | null,
  profile: StackProfile,
): SuspectedOwner | null {
  if (step.name === "boot" || step.name === "smoke" || step.name === "stop")
    return OWNERS.backend;
  return file ? ownerOf(file, profile) : null;
}

function stepError(step: TestStep): string {
  const lines = step.output.split("\n").map((line) => line.trim());
  switch (step.name) {
    case "smoke":
      return `Smoke tests failed: ${lines.filter(Boolean).join("; ")}`;
    case "boot":
    case "stop":
    case "install":
    case "unit": {
      const error =
        lines.find((line) =>
          /^([A-Z]\w*)?Error\b|^npm (ERR|error)!?|error TS\d+/.test(line),
        ) ?? lines.filter(Boolean).at(-1);
      return error ?? `The ${step.name} step failed.`;
    }
  }
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

/** The first application file the text mentions, e.g. in a stack trace. */
function firstAppFile(text: string, profile: StackProfile): string | null {
  const folders = [
    ...new Set(
      Object.values(profile.writablePaths)
        .flat()
        .filter((path) => path.endsWith("/")),
    ),
  ].map((folder) => folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const match = new RegExp(
    `(?:^|[\\s(/])((?:${folders.join("|")})[\\w./-]*\\.[\\w]+)`,
    "m",
  ).exec(text);
  return match?.[1] ?? null;
}

function firstLine(text: string): string | null {
  return (
    stripAnsi(text)
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
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

/** The start of a test's failure: the assertion and its code frame come first. */
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
 * What stays the same when the same failure happens again: the step, the
 * test and the error, without what varies between runs (timings, line and
 * column numbers, temp paths, ids).
 */
export function normalizeError(error: string): string {
  return stripAnsi(error)
    .replace(/\d+(\.\d+)?\s?(ms|s)\b/g, "<time>")
    .replace(/:\d+:\d+/g, ":<line>")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "<timestamp>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\s+/g, " ")
    .trim();
}

function report(fields: Omit<IssueReport, "signature">): IssueReport {
  const signature = createHash("sha256")
    .update(
      [
        fields.step,
        fields.failingTest ?? "",
        normalizeError(fields.error),
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 16);
  return { ...fields, signature };
}
