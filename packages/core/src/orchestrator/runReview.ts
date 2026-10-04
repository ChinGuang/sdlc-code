/**
 * The review a Run gets before anyone is asked to look at its pull request
 * (T19, UML diagram 8): the Stack Profile's linters in the sandbox, then the
 * Code Review Agent over the diff.
 *
 * It is one call rather than three, because the order is not the caller's
 * business: the layered Review Standard decides how serious a linter's
 * complaint is, and the agent is told what the linters already found so it does
 * not repeat them. The Orchestrator only decides what the Findings mean.
 */
import {
  brokenChecks,
  type Rule,
  type StackProfile,
} from "@sdlc-code/stack-profiles";
import type { AgentLoopResult } from "../agentLoop/agentLoop.js";
import type { CodeReviewAgent } from "../agents/codeReview/codeReviewAgent.js";
import type { Finding } from "../agents/codeReview/findings.js";
import { findingsFromLint } from "../agents/codeReview/linterFindings.js";
import {
  layerReviewStandard,
  parseUserRules,
} from "../agents/codeReview/reviewStandard.js";
import type { Run } from "../domain/entities.js";
import type { DocumentStore } from "../persistence/documentStore.js";
import type { LintRunner } from "../testRuns/lintRunner.js";
import type { WorkspaceManager } from "../workspaces/workspaceManager.js";
import { loadApprovedDocuments } from "./approvedDocuments.js";

export type RunReviewResult = {
  /** Everything the linters and the agent found, with its Rule's severity. */
  findings: Finding[];
  /**
   * Why the agent stopped. A review that ran out of turns or Token Budget read
   * only part of the diff, so its silence is not evidence of clean code.
   */
  stopReason: AgentLoopResult["stopReason"];
  /**
   * What made this review less trustworthy than it looks: a linter that could
   * not run, a Rule ID nobody has, a user's Rule that could not be read.
   */
  problems: string[];
};

/** The review the Orchestrator asks for when a Run reaches reviewing. */
export interface RunReview {
  reviewRun: (run: Run) => Promise<RunReviewResult>;
}

export type AgentRunReviewOptions = {
  documents: DocumentStore;
  /** The Run's repository: the files to lint and the diff to read. */
  workspaces: Pick<
    WorkspaceManager,
    "readFiles" | "lastSliceCommit" | "runDiff"
  >;
  profile: (run: Run) => StackProfile;
  linters: LintRunner;
  agent: CodeReviewAgent;
  /**
   * The user's own standards, as the text of their AGENTS.md; null when the
   * Target Repo has none, which is the common case.
   */
  userStandards?: (run: Run) => Promise<string | null>;
};

export class AgentRunReview implements RunReview {
  #options: AgentRunReviewOptions;

  constructor(options: AgentRunReviewOptions) {
    this.#options = options;
  }

  reviewRun = async (run: Run): Promise<RunReviewResult> => {
    const problems: string[] = [];
    const standard = await this.#standard(run, problems);
    const fromLinters = await this.#linters(run, standard, problems);
    const reviewed = await this.#options.agent.review({
      projectRequest: run.projectRequest,
      profile: this.#options.profile(run),
      documents: loadApprovedDocuments(this.#options.documents, run.id),
      standard,
      diff: await this.#options.workspaces.runDiff(),
      linterFindings: fromLinters,
    });
    for (const unknown of reviewed.unknownRuleIds)
      problems.push(
        `The Code Review Agent cited ${unknown}, which this Review Standard does not have.`,
      );
    problems.push(...reviewed.notRecorded);
    return {
      findings: [...fromLinters, ...reviewed.findings],
      stopReason: reviewed.loop.stopReason,
      problems,
    };
  };

  /** The Stack Profile's Rules, with the user's own layered on. */
  async #standard(run: Run, problems: string[]): Promise<Rule[]> {
    const baseline = this.#options.profile(run).reviewStandard;
    const markdown = (await this.#options.userStandards?.(run)) ?? null;
    if (markdown === null) return [...baseline];
    const { rules, problems: unreadable } = parseUserRules(markdown);
    for (const problem of unreadable) problems.push(`AGENTS.md: ${problem}`);
    return layerReviewStandard(baseline, rules);
  }

  /** What the linters found, as Findings of this Run's Rules. */
  async #linters(
    run: Run,
    standard: readonly Rule[],
    problems: string[],
  ): Promise<Finding[]> {
    const { workspaces, linters, profile } = this.#options;
    const outcome = await linters.runLinters({
      profile: profile(run),
      files: await workspaces.readFiles(await workspaces.lastSliceCommit()),
    });
    if (outcome.status === "broken") {
      // Our own tooling failing is not the application's fault, so it does not
      // block the pull request; it is said out loud instead of passing quietly.
      problems.push(`The linters did not run: ${outcome.problem}`);
      return [];
    }
    for (const check of brokenChecks(outcome.result))
      problems.push(
        `${check.name} failed without reporting anything: ${check.output.slice(-200)}`,
      );
    const { findings, unknownRuleIds } = findingsFromLint(
      outcome.result,
      standard,
    );
    for (const unknown of unknownRuleIds)
      problems.push(
        `The linters report against ${unknown}, which this Review Standard does not have.`,
      );
    return findings;
  }
}
