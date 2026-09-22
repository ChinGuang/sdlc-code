/**
 * The Testing Agent (CONTEXT.md): runs a Slice's merged code in the sandbox
 * and hands the Orchestrator Issue Reports, never another agent.
 */
import type { StackProfile, TemplateFile } from "@sdlc-code/stack-profiles";
import type { TestRunner, TestRunOutcome } from "../../testRuns/testRunner.js";
import { issueReports, type IssueReport } from "./issueReports.js";

export type TestSliceInput = {
  profile: StackProfile;
  /** Every file of the merged Slice (WorkspaceManager.readFiles). */
  files: readonly TemplateFile[];
};

export type TestSliceResult = {
  /** True only when every step of the test script passed. */
  passed: boolean;
  issueReports: IssueReport[];
  /** The Test Run itself, for the Slice Commit and the dashboard. */
  testRun: TestRunOutcome;
};

export interface TestingAgent {
  testSlice: (input: TestSliceInput) => Promise<TestSliceResult>;
}

export class SandboxTestingAgent implements TestingAgent {
  #runner: TestRunner;

  constructor(options: { runner: TestRunner }) {
    this.#runner = options.runner;
  }

  testSlice = async ({
    profile,
    files,
  }: TestSliceInput): Promise<TestSliceResult> => {
    const testRun = await this.#runner.runTests({ profile, files });
    return {
      passed: testRun.status === "passed",
      issueReports: issueReports(testRun, profile),
      testRun,
    };
  };
}
