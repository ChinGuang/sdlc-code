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
import type { TestRunner, TestRunOutcome } from "../../testRuns/testRunner.js";
import {
  codingIssues,
  issueReports,
  type SuspectedOwner,
} from "../testing/issueReports.js";
import { listIssues, type CodingIssue } from "./codingContext.js";
import {
  MAX_LISTED_FILES,
  mayWrite,
  WorkspaceFileError,
  type WorkspaceFiles,
} from "./workspaceFiles.js";

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
    let outcome: TestRunOutcome;
    try {
      outcome = await this.#options.runner.runTests({
        profile,
        files,
        command: profile.checkCommand[side],
        // A hung check must not hold a Step for a Test Run's half hour.
        timeoutSeconds: CHECK_TIMEOUT_SECONDS,
      });
    } catch (error) {
      this.#options.onProblem?.(
        `The ${side} could not check its work: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    // A run that never reported says nothing about the code.
    if (outcome.status !== "failed") return null;
    // The whole project is typechecked: what the other side wrote is not
    // this side's to fix, and the Test Run will route it there.
    const own = issueReports(outcome, profile).filter(
      (report) =>
        report.suspectedOwner === null || report.suspectedOwner === OWNER[side],
    );
    return own.length > 0 ? sendBack(codingIssues(own)) : null;
  };
}

const OWNER: Record<CodingSide, SuspectedOwner> = {
  backend: "backendCoding",
  frontend: "frontendCoding",
};

/** Install, typecheck and one side's tests take minutes, not a half hour. */
const CHECK_TIMEOUT_SECONDS = 600;

/**
 * Every file of a Workspace, as a check uploads it; null when it has more
 * than can be listed. A file the agents cannot read (binary, or too big to
 * read) is left out: none of the template's files is either, so leaving one
 * out never removes a template file in the sandbox.
 */
export function wholeApplication(
  files: Pick<WorkspaceFiles, "listFiles" | "readFile">,
): TemplateFile[] | null {
  const paths = files.listFiles();
  if (paths.length >= MAX_LISTED_FILES) return null;
  return paths.flatMap((path) => {
    try {
      return [{ path, contents: files.readFile(path) }];
    } catch (error) {
      if (error instanceof WorkspaceFileError) return [];
      throw error;
    }
  });
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
  return files
    .filter((file) => mayWrite(profile.writablePaths[side], file.path))
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

/**
 * What the agent is told: its work is not done, and what to fix first, in
 * the shape a Test Run's problems take (its evidence is cut there already).
 */
function sendBack(issues: readonly CodingIssue[]): string {
  return `Your work does not pass its own check yet, so it is not done. Fix these, then reply again with your summary:\n${listIssues(issues)}`;
}
