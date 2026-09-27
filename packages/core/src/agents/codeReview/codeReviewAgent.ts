/**
 * The Code Review Agent (CONTEXT.md, UML diagram 8): reads what the Run changed
 * and reports Findings against the layered Review Standard and the Approved
 * Documents. It is the one agent that writes no code — it only cites Rules.
 *
 * It is told what the linters already found, so it spends its turns on what a
 * tool cannot see: a Slice that does not do what its documents say, a route that
 * answers something other than the API Contract, a test that asserts nothing.
 *
 * Findings arrive through a tool, a few at a time (spike T03: Nemotron breaks on
 * large nested arguments), and the Step ends when the agent replies.
 */
import type { Rule, StackProfile } from "@sdlc-code/stack-profiles";
import { stringify } from "yaml";
import { z } from "zod";
import type { AgentLoop, AgentLoopResult } from "../../agentLoop/agentLoop.js";
import { defineTool, type AgentTool } from "../../agentLoop/tools.js";
import type { ApprovedDocuments } from "../coding/codingContext.js";
import {
  findingsFor,
  ReportedFindingSchema,
  type Finding,
  type ReportedFinding,
} from "./findings.js";

export const SUBMIT_FINDINGS = "submit_findings";
/** Enough for one pass over a file; more would risk a truncated tool call. */
const MAX_FINDINGS_PER_CALL = 5;

export type CodeReviewInput = {
  projectRequest: string;
  profile: StackProfile;
  /** The Run's Approved Documents: what the code was supposed to become. */
  documents: ApprovedDocuments;
  /** The Review Standard as this Run layered it (reviewStandard.ts). */
  standard: readonly Rule[];
  /** Everything the Run changed, as a unified diff (WorkspaceManager.runDiff). */
  diff: string;
  /** What the linters already reported, so the agent does not repeat them. */
  linterFindings: readonly Finding[];
};

export type CodeReviewResult = {
  findings: Finding[];
  /** Rule IDs the agent cited that the Review Standard does not have. */
  unknownRuleIds: string[];
  loop: AgentLoopResult;
};

export interface CodeReviewAgent {
  review: (input: CodeReviewInput) => Promise<CodeReviewResult>;
}

export type CodeReviewAgentOptions = {
  createLoop: (tools: AgentTool[]) => AgentLoop;
};

export class LoopCodeReviewAgent implements CodeReviewAgent {
  #createLoop: CodeReviewAgentOptions["createLoop"];

  constructor(options: CodeReviewAgentOptions) {
    this.#createLoop = options.createLoop;
  }

  review = async (input: CodeReviewInput): Promise<CodeReviewResult> => {
    const reported: ReportedFinding[] = [];
    const submit = defineTool({
      name: SUBMIT_FINDINGS,
      description: `Report up to ${MAX_FINDINGS_PER_CALL} Findings, each citing a Rule ID from the Review Standard. Call it again for more.`,
      input: z.object({
        findings: ReportedFindingSchema.array().max(MAX_FINDINGS_PER_CALL),
      }),
      run: ({ findings }) => {
        reported.push(...findings);
        return `${findings.length} Finding${findings.length === 1 ? "" : "s"} recorded (${reported.length} in all). Report more, or reply when the review is done.`;
      },
    });

    const loop = await this.#createLoop([submit]).run({
      system: systemPrompt(input.standard),
      user: userMessage(input),
    });
    const { findings, unknownRuleIds } = findingsFor(
      reported,
      input.standard,
      "codeReview",
    );
    return { findings, unknownRuleIds, loop };
  };
}

function systemPrompt(standard: readonly Rule[]): string {
  const rules = standard
    .map((rule) => `- ${rule.id} (${rule.severity}): ${rule.description}`)
    .join("\n");
  return `You are the Code Review Agent of sdlc-code, a multi-agent tool that builds full-stack applications. Other agents wrote the code; you review it.

Review the diff against the Review Standard and the Approved Documents, and report what is actually wrong.

The Review Standard:
${rules}

How to review:
- Every Finding cites one Rule ID from the list above. A problem no Rule covers is not a Finding; leave it out.
- Report the file and line from the diff's own headers, so the Finding points at real code.
- Say what is wrong in one sentence, and what to do instead when it is not obvious.
- Judge the code against the Approved Documents too: an endpoint that answers something the API Contract does not describe, or a screen the UI Spec does not have, breaks a Rule about following them.
- Do not repeat a Finding the linters already reported, and do not report style a linter would have caught.
- Do not report on code the diff does not show, and do not ask for changes you cannot point at.
- Blocking Rules send the work back to the Coding Agents, so be sure: a blocking Finding must be something a reviewer would refuse to merge.

Call ${SUBMIT_FINDINGS} as often as you need, then reply with one sentence: what you reviewed and what you found. A review that finds nothing is a good result — reply and report none.`;
}

function userMessage(input: CodeReviewInput): string {
  const slices = input.documents.slicePlan
    .map((slice, index) => `${index + 1}. ${slice.title}: ${slice.goal}`)
    .join("\n");
  const linters =
    input.linterFindings.length === 0
      ? "The linters found nothing."
      : input.linterFindings
          .map(
            (finding) =>
              `- ${finding.ruleId} ${finding.file}:${finding.line} — ${finding.message}`,
          )
          .join("\n");
  return [
    `Project Request:\n${input.projectRequest}`,
    `Stack: ${input.profile.name} (${input.profile.summary})`,
    `System Design:\n${input.documents.systemDesign.trim()}`,
    `Slice Plan:\n${slices}`,
    `API Contract (OpenAPI):\n${stringify(input.documents.apiContract).trim()}`,
    `UI Spec:\n${stringify({ screens: input.documents.uiSpec.screens }).trim()}`,
    `Already reported by the linters (do not repeat these):\n${linters}`,
    `The diff of everything this Run built:\n${input.diff}`,
  ].join("\n\n");
}
