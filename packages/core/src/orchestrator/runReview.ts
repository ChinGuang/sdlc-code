/**
 * The review a Run gets before anyone is asked to look at its pull request
 * (T19, UML diagram 8): the Stack Profile's linters in the sandbox, then the
 * Code Review Agent over the diff.
 *
 * It is one seam rather than three options on the Orchestrator, because the
 * three parts only make sense together: the Review Standard decides how serious
 * a linter's complaint is, and the agent is told what the linters already found
 * so it does not repeat them.
 */
import type { Rule, StackProfile } from "@sdlc-code/stack-profiles";
import type { Run } from "../domain/entities.js";
import type { DocumentStore } from "../persistence/documentStore.js";
import type { WorkspaceManager } from "../workspaces/workspaceManager.js";
import type { LintRunner } from "../testRuns/lintRunner.js";
import type { CodeReviewAgent } from "../agents/codeReview/codeReviewAgent.js";
import { findingsFromLint } from "../agents/codeReview/linterFindings.js";
import type { Finding } from "../agents/codeReview/findings.js";
import {
  layerReviewStandard,
  parseUserRules,
} from "../agents/codeReview/reviewStandard.js";
import { loadApprovedDocuments } from "./approvedDocuments.js";

export type ReviewedFindings = {
  findings: Finding[];
  unknownRuleIds: string[];
};

/** What the Orchestrator asks for when a Run reaches reviewing. */
export interface RunReview {
  /** The Stack Profile's Rules, with the user's own layered on. */
  reviewStandard: (run: Run) => Promise<Rule[]>;
  /** What the linters found, as Findings against `standard`. */
  runLinters: (run: Run, standard: readonly Rule[]) => Promise<Finding[]>;
  /** What the Code Review Agent found, reading the diff and the documents. */
  review: (
    run: Run,
    standard: readonly Rule[],
    linterFindings: readonly Finding[],
  ) => Promise<ReviewedFindings>;
}

export type AgentRunReviewOptions = {
  documents: DocumentStore;
  workspaces: WorkspaceManager;
  profile: (run: Run) => StackProfile;
  linters: LintRunner;
  agent: CodeReviewAgent;
  /**
   * The user's own standards, as the text of their AGENTS.md; null when the
   * Target Repo has none, which is the common case.
   */
  userStandards?: (run: Run) => Promise<string | null>;
  /** Told when a linter could not run, or a user's Rule could not be read. */
  onProblem?: (problem: string) => void;
};

export class AgentRunReview implements RunReview {
  #options: AgentRunReviewOptions;

  constructor(options: AgentRunReviewOptions) {
    this.#options = options;
  }

  reviewStandard = async (run: Run): Promise<Rule[]> => {
    const baseline = this.#options.profile(run).reviewStandard;
    const markdown = (await this.#options.userStandards?.(run)) ?? null;
    if (markdown === null) return [...baseline];
    const { rules, problems } = parseUserRules(markdown);
    for (const problem of problems)
      this.#options.onProblem?.(`AGENTS.md: ${problem}`);
    return layerReviewStandard(baseline, rules);
  };

  runLinters = async (
    run: Run,
    standard: readonly Rule[],
  ): Promise<Finding[]> => {
    const { workspaces, linters, profile } = this.#options;
    const outcome = await linters.runLinters({
      profile: profile(run),
      files: await workspaces.readFiles(await workspaces.lastSliceCommit()),
    });
    if (outcome.status === "broken") {
      // Our own tooling failing is not the application's fault, so it does not
      // block the pull request; it is said out loud instead of passing quietly.
      this.#options.onProblem?.(`The linters did not run: ${outcome.problem}`);
      return [];
    }
    for (const check of outcome.result.checks.filter((one) => !one.ok))
      if (!outcome.result.problems.some((one) => one.tool === check.name))
        this.#options.onProblem?.(
          `${check.name} failed without reporting anything: ${check.output.slice(-200)}`,
        );
    const { findings, unknownRuleIds } = findingsFromLint(
      outcome.result,
      standard,
    );
    for (const unknown of unknownRuleIds)
      this.#options.onProblem?.(
        `The linters report against ${unknown}, which this Review Standard does not have.`,
      );
    return findings;
  };

  review = async (
    run: Run,
    standard: readonly Rule[],
    linterFindings: readonly Finding[],
  ): Promise<ReviewedFindings> => {
    const { documents, workspaces, agent, profile } = this.#options;
    const result = await agent.review({
      projectRequest: run.projectRequest,
      profile: profile(run),
      documents: loadApprovedDocuments(documents, run.id),
      standard,
      diff: await workspaces.runDiff(),
      linterFindings,
    });
    return {
      findings: result.findings,
      unknownRuleIds: result.unknownRuleIds,
    };
  };
}
