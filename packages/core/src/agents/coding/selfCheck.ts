/**
 * A Coding Agent's own check before its Step ends (T24j). Agents handed in
 * code that did not compile (an invalid `<htmlFor>` JSX tag, a missing
 * `useEffect` import, tests written for Jest), and each mistake cost a full
 * Test Run and a retry (Run #e29ca700). So when an agent answers, its side is
 * read for the mistakes a file shows on its own, then typechecked and its own
 * tests run in the sandbox; what fails goes back to the agent, by file and
 * line, while it still has turns to fix it.
 */
import type {
  CheapCheck,
  CodingSide,
  StackProfile,
  TemplateFile,
} from "@sdlc-code/stack-profiles";
import type { TestRunner } from "../../testRuns/testRunner.js";
import { codingIssues, issueReports } from "../testing/issueReports.js";
import type { CodingIssue } from "./codingContext.js";

export type SelfCheckInput = {
  profile: StackProfile;
  side: CodingSide;
  /** Every file of the side's Workspace, as the agent left it. */
  files: readonly TemplateFile[];
};

/** What is still wrong with a side's work; null when nothing is. */
export interface SelfCheck {
  check: (input: SelfCheckInput) => Promise<string | null>;
}

export type SandboxSelfCheckOptions = {
  runner: TestRunner;
  /** Told when the sandbox could not check; the Test Run judges the work. */
  onProblem?: (problem: string) => void;
};

/** Evidence is for a model to read; the Test Run keeps the whole log. */
const MAX_EVIDENCE_CHARS = 800;

export class SandboxSelfCheck implements SelfCheck {
  #options: SandboxSelfCheckOptions;

  constructor(options: SandboxSelfCheckOptions) {
    this.#options = options;
  }

  check = async ({
    profile,
    side,
    files,
  }: SelfCheckInput): Promise<string | null> => {
    // Reading files costs nothing; a sandbox run costs a minute or more.
    const cheap = cheapFindings(files, profile, side);
    if (cheap.length > 0) return sendBack(cheap);
    let outcome;
    try {
      outcome = await this.#options.runner.runTests({
        profile,
        files,
        command: profile.checkCommand[side],
      });
    } catch (error) {
      this.#options.onProblem?.(
        `The ${side} could not check its work: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    // A run that never reported says nothing about the code.
    if (outcome.status !== "failed") return null;
    const issues = codingIssues(issueReports(outcome, profile));
    return issues.length > 0 ? sendBack(issues) : null;
  };
}

/**
 * The profile's cheap checks over the files this side may write: each line
 * that holds what a check forbids, by file and line, with what to do.
 */
export function cheapFindings(
  files: readonly TemplateFile[],
  profile: StackProfile,
  side: CodingSide,
): CodingIssue[] {
  const writable = profile.writablePaths[side];
  const mayWrite = (path: string) =>
    writable.some((entry) =>
      entry.endsWith("/") ? path.startsWith(entry) : path === entry,
    );
  return files
    .filter((file) => mayWrite(file.path))
    .flatMap((file) =>
      profile.cheapChecks
        .filter((check) => check.files.test(file.path))
        .flatMap((check) => findingsIn(file, check)),
    );
}

function findingsIn(file: TemplateFile, check: CheapCheck): CodingIssue[] {
  return file.contents.split("\n").flatMap((line, index) =>
    check.forbidden.test(line)
      ? [
          {
            summary: `${file.path}:${index + 1}: ${check.says}`,
            evidence: line.trim(),
          },
        ]
      : [],
  );
}

/** What the agent is told: its work is not done, and what to fix first. */
function sendBack(issues: readonly CodingIssue[]): string {
  const list = issues
    .map(
      (issue, index) =>
        `${index + 1}. ${issue.summary}\n   Evidence: ${cut(issue.evidence).replaceAll("\n", "\n   ")}`,
    )
    .join("\n");
  return `Your work does not pass its own check yet, so it is not done. Fix these, then reply again with your summary:\n${list}`;
}

const cut = (text: string): string =>
  text.length <= MAX_EVIDENCE_CHARS
    ? text.trim()
    : `${text.slice(0, MAX_EVIDENCE_CHARS).trim()}…`;
