/**
 * The Orchestrator's judgement on an Issue Report the Approved Documents do
 * not settle (diagram 7, questions 1–3). One forced tool call with three flat
 * arguments (spike T03: forcing works on every Nemotron; small arguments stay
 * intact); the answer is validated, and anything invalid means "undecidable".
 */
import {
  ChatApiError,
  parseToolArguments,
  type ChatRequest,
} from "@sdlc-code/clients";
import { stringify } from "yaml";
import { z } from "zod";
import type { CompletionClient, TokenBudget } from "../agentLoop/agentLoop.js";
import type { IssueReport } from "../agents/testing/issueReports.js";
import {
  OWNER_RULES,
  OWNERS,
  type OwnerContext,
  type OwnerDecision,
  type OwnerJudge,
} from "./ownerResolution.js";

export const DECIDE_OWNER = "decide_owner";

const Decision = z.object({
  owner: z.enum(OWNERS),
  rule: z.enum(OWNER_RULES),
  reason: z.string().trim().min(1).max(600),
});

/** Each rule has the Owners diagram 7 allows for it. */
const OWNERS_BY_RULE: Record<OwnerDecision["rule"], readonly string[]> = {
  codeDeviates: ["backendCoding", "frontendCoding"],
  documentsContradict: ["systemDesign", "uiDesign"],
  requirementMissing: ["systemDesign"],
  undecidable: ["human"],
};

export const OWNER_JUDGE_PROMPT = `You are the Orchestrator of sdlc-code. A Test Run failed and the evidence does not show who should fix it. Decide the Owner by asking these questions in order, and stop at the first "yes":

1. Does the code deviate from the API Contract or the UI Spec? Owner: backendCoding for the API, frontendCoding for the screens. rule: codeDeviates.
2. Do the Approved Documents contradict each other? Owner: uiDesign if the UI Spec deviates, systemDesign if the System Design, Slice Plan or API Contract does. rule: documentsContradict.
3. Is a requirement missing or wrong in the documents? Owner: systemDesign. rule: requirementMissing.
4. Otherwise: owner human, rule undecidable.

Base the answer on the evidence and the documents only. Call ${DECIDE_OWNER} once with the owner, the rule and a one-sentence reason that names the evidence.`;

export type ModelOwnerJudgeOptions = {
  client: CompletionClient;
  /** The orchestrator role's model and thinking switch (requestOptionsFor). */
  request: Pick<ChatRequest, "model" | "extra">;
  budget?: TokenBudget;
};

export class ModelOwnerJudge implements OwnerJudge {
  #client: CompletionClient;
  #request: Pick<ChatRequest, "model" | "extra">;
  #budget: TokenBudget | undefined;

  constructor(options: ModelOwnerJudgeOptions) {
    this.#client = options.client;
    this.#request = options.request;
    this.#budget = options.budget;
  }

  judge = async (
    report: IssueReport,
    context: OwnerContext,
  ): Promise<OwnerDecision | null> => {
    if (this.#budget && this.#budget.remaining() <= 0) return null;
    let response;
    try {
      response = await this.#client.complete({
        ...this.#request,
        messages: [
          { role: "system", content: OWNER_JUDGE_PROMPT },
          { role: "user", content: judgeMessage(report, context) },
        ],
        tools: [
          {
            name: DECIDE_OWNER,
            description: "Record who should fix the Issue Report, and why.",
            parameters: {
              type: "object",
              properties: {
                owner: { type: "string", enum: [...OWNERS] },
                rule: { type: "string", enum: [...OWNER_RULES] },
                reason: { type: "string" },
              },
              required: ["owner", "rule", "reason"],
            },
          },
        ],
        toolChoice: { name: DECIDE_OWNER },
        maxTokens: 2000,
      });
    } catch (error) {
      // A person decides rather than the Run failing on a judgement call.
      if (error instanceof ChatApiError) return null;
      throw error;
    }
    this.#budget?.spend(
      response.usage.promptTokens + response.usage.completionTokens,
    );
    const call = response.toolCalls.find((c) => c.name === DECIDE_OWNER);
    if (!call || response.finishReason === "length") return null;
    const parsed = parseToolArguments(call.arguments);
    if (!parsed.ok) return null;
    const decision = Decision.safeParse(parsed.value);
    if (!decision.success) return null;
    // An Owner the rule does not allow is not an answer to the question asked.
    if (!OWNERS_BY_RULE[decision.data.rule].includes(decision.data.owner))
      return null;
    return decision.data;
  };
}

function judgeMessage(report: IssueReport, context: OwnerContext): string {
  const screens = context.documents.uiSpec.screens.filter(
    (screen) => screen.sliceTitle === context.slice.title,
  );
  return [
    `Issue Report:\n${stringify({
      step: report.step,
      failingTest: report.failingTest,
      file: report.file,
      endpoint: report.endpoint,
      error: report.error,
      suspectedOwner: report.suspectedOwner,
    }).trim()}\n\nEvidence:\n${report.evidence}`,
    `Slice being built: ${context.slice.title}: ${context.slice.goal} (endpoints: ${context.slice.endpoints.join(", ") || "none"})`,
    `API Contract (OpenAPI):\n${stringify(context.documents.apiContract).trim()}`,
    `UI Spec screens of this Slice:\n${stringify(
      screens.map((screen) => ({
        name: screen.name,
        route: screen.route,
        endpoints: screen.endpoints,
        states: screen.states,
      })),
    ).trim()}`,
    `System Design:\n${context.documents.systemDesign.trim()}`,
  ].join("\n\n");
}
