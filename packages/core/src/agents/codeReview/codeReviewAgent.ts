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
import { quoteIsShown, shownByDiff, type ShownDiff } from "./reviewDiff.js";

export const SUBMIT_FINDINGS = "submit_findings";
/** Enough for one pass over a file; more would risk a truncated tool call. */
const MAX_FINDINGS_PER_CALL = 5;
/**
 * What one call may hold before it is refused. A review of a whole Run finds
 * more than five things, and refusing the call wasted the turn that wrote it
 * (T25); the advice stays at a few at a time.
 */
const MAX_FINDINGS_PER_CALL_ACCEPTED = 30;
/** A review that reports more than this has stopped being a review. */
const MAX_FINDINGS_RECORDED = 40;

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
  /** Findings not recorded because the diff does not support them (T25a). */
  notRecorded: string[];
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
    const refused: Array<{ finding: ReportedFinding; why: string }> = [];
    const shown = shownByDiff(input.diff);
    const rules = new Map(input.standard.map((rule) => [rule.id, rule]));
    const submit = defineTool({
      name: SUBMIT_FINDINGS,
      description: `Report Findings, a few at a time (up to ${MAX_FINDINGS_PER_CALL} is best), each citing a Rule ID from the Review Standard and a file and line the diff shows. A blocking Rule's Finding must also quote the line of code it is about. Call it again for more.`,
      input: z.object({
        findings: ReportedFindingSchema.array().max(
          MAX_FINDINGS_PER_CALL_ACCEPTED,
        ),
      }),
      run: ({ findings }) => {
        const notes: string[] = [];
        let recorded = 0;
        for (const finding of findings) {
          const why = whyNotShown(finding, rules.get(finding.ruleId), shown);
          if (why) {
            refused.push({ finding, why });
            notes.push(`- ${finding.ruleId} ${place(finding)}: ${why}`);
          } else if (reported.length >= MAX_FINDINGS_RECORDED) {
            notes.push(
              `- ${finding.ruleId} ${place(finding)}: enough Findings are recorded; reply now`,
            );
          } else {
            reported.push(finding);
            recorded++;
          }
        }
        const head = `${recorded} Finding${recorded === 1 ? "" : "s"} recorded (${reported.length} in all).`;
        const refusals =
          notes.length > 0
            ? ` Not recorded:\n${notes.join("\n")}\nSend those again corrected if they are real, or leave them out.`
            : "";
        return `${head}${refusals} Report more, or reply when the review is done.`;
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
    // A refusal the agent then put right is not worth a person's attention.
    const notRecorded = refused
      .filter(
        ({ finding }) =>
          !reported.some(
            (kept) =>
              kept.file === finding.file && kept.ruleId === finding.ruleId,
          ),
      )
      .map(
        ({ finding, why }) =>
          `The Code Review Agent's ${finding.ruleId} Finding at ${place(finding)} was not recorded: ${why}.`,
      );
    return { findings, unknownRuleIds, notRecorded, loop };
  };
}

const place = (finding: ReportedFinding): string =>
  finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;

/**
 * Why the diff does not support a Finding, or null when it does. A Finding
 * about a file or a line the diff does not show cannot be right; a blocking
 * one sends work back, so it must also quote the code it is about. The
 * linters own the LINT Rules: they ran, and their Findings are complete.
 */
function whyNotShown(
  finding: ReportedFinding,
  rule: Rule | undefined,
  shown: ShownDiff,
): string | null {
  if (finding.ruleId.startsWith("LINT-"))
    return "the linters report the LINT Rules, and what they found is listed above";
  const file = shown.get(finding.file);
  if (!file)
    return `the diff does not show ${finding.file} (use the path as the diff writes it)`;
  if (finding.line > 0 && !file.has(finding.line))
    return `the diff does not show line ${finding.line} of ${finding.file}`;
  if (rule?.severity !== "blocking") return null;
  if (!finding.quote?.trim())
    return "a blocking Finding must quote the line of code it is about (quote), copied from the diff";
  return quoteIsShown(file, finding.line, finding.quote)
    ? null
    : `the diff does not show that code at ${place(finding)}`;
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
- Report the file and line from the diff's own headers, so the Finding points at real code. A Finding about a file or a line the diff does not show is not recorded.
- A blocking Rule's Finding also quotes the line of code it is about (quote), copied exactly from the diff. If you cannot quote it, it is not something to block on.
- Never report a compile error, a type error, a missing import or an undefined name, and never cite a LINT Rule: the compiler and ESLint ran, and what they found is listed in the next message. A file you have not read in full may be longer than the part the diff shows.
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
