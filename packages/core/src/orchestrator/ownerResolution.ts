/**
 * Owner resolution (CONTEXT.md "Owner", UML diagram 7): who fixes an Issue
 * Report, decided by comparing its evidence against the Approved Documents in
 * a fixed order:
 *   1. code deviates from a document     → that side's Coding Agent
 *   2. documents contradict each other   → the design agent whose document deviates
 *   3. a requirement is missing or wrong → System Design Agent
 *   4. undecidable                       → a human
 * What the documents settle is decided here in code; only a report they cannot
 * settle goes to the judge (a model), whose answer is checked like any input.
 */
import type { AgentRole } from "../agentRoles.js";
import type { ApprovedDocuments } from "../agents/coding/codingContext.js";
import type { DesignSlice } from "../agents/systemDesign/design.js";
import { contractEndpoints } from "../agents/systemDesign/validateDesign.js";
import type { IssueReport } from "../agents/testing/issueReports.js";

export const OWNERS = [
  "backendCoding",
  "frontendCoding",
  "systemDesign",
  "uiDesign",
  "human",
] as const satisfies ReadonlyArray<AgentRole | "human">;
export type Owner = (typeof OWNERS)[number];

/** Which question of diagram 7 decided the Owner. */
export const OWNER_RULES = [
  "codeDeviates",
  "documentsContradict",
  "requirementMissing",
  "undecidable",
] as const;
export type OwnerRule = (typeof OWNER_RULES)[number];

export type OwnerDecision = {
  owner: Owner;
  rule: OwnerRule;
  /** One sentence, for the Transcript and the Escalation summary. */
  reason: string;
};

export type OwnerContext = {
  documents: ApprovedDocuments;
  /** The Slice being built. */
  slice: DesignSlice;
};

/** Decides an Owner the documents alone cannot; null when it cannot either. */
export interface OwnerJudge {
  judge: (
    report: IssueReport,
    context: OwnerContext,
  ) => Promise<OwnerDecision | null>;
}

export interface OwnerResolver {
  resolve: (
    report: IssueReport,
    context: OwnerContext,
  ) => Promise<OwnerDecision>;
}

export class RuleOwnerResolver implements OwnerResolver {
  #judge: OwnerJudge | null;

  constructor(options: { judge?: OwnerJudge } = {}) {
    this.#judge = options.judge ?? null;
  }

  resolve = async (
    report: IssueReport,
    context: OwnerContext,
  ): Promise<OwnerDecision> => {
    const settled = resolveByDocuments(report, context);
    if (settled) return settled;
    const judged = this.#judge
      ? await this.#judge.judge(report, context)
      : null;
    return (
      judged ?? {
        owner: "human",
        rule: "undecidable",
        reason: `Neither the evidence nor the Approved Documents say who should fix: ${report.error}`,
      }
    );
  };
}

/**
 * The questions of diagram 7 the documents answer by themselves, in order;
 * null when they do not settle it.
 */
export function resolveByDocuments(
  report: IssueReport,
  { documents }: OwnerContext,
): OwnerDecision | null {
  const contract = new Set(contractEndpoints(documents.apiContract));
  const endpoint = report.endpoint;
  const specified = endpoint === null || contract.has(endpoint);

  // 1. The code deviates: the evidence points at one side, about something
  // the documents specify.
  if (report.suspectedOwner && specified)
    return {
      owner: report.suspectedOwner,
      rule: "codeDeviates",
      reason: `${where(report)} fails in ${side(report.suspectedOwner)} code${endpoint ? ` for ${endpoint}, which the API Contract defines` : ""}.`,
    };

  if (endpoint && !contract.has(endpoint)) {
    // 2. The documents contradict each other: another document relies on an
    // operation the API Contract lacks.
    const screens = documents.uiSpec.screens.filter((screen) =>
      screen.endpoints.includes(endpoint),
    );
    if (screens.length > 0)
      return {
        owner: "uiDesign",
        rule: "documentsContradict",
        reason: `The UI Spec's ${screens.map((screen) => `"${screen.name}"`).join(", ")} calls ${endpoint}, which the API Contract does not define.`,
      };
    if (
      documents.slicePlan.some((planned) =>
        planned.endpoints.includes(endpoint),
      )
    )
      return {
        owner: "systemDesign",
        rule: "documentsContradict",
        reason: `The Slice Plan lists ${endpoint}, which the API Contract does not define.`,
      };
    // The code built an operation no document asks for: that is the code
    // deviating, whichever side the evidence points at.
    if (report.suspectedOwner)
      return {
        owner: report.suspectedOwner,
        rule: "codeDeviates",
        reason: `${where(report)} tests ${endpoint}, which no Approved Document defines.`,
      };
  }
  return null;
}

function where(report: IssueReport): string {
  return report.failingTest
    ? `"${report.failingTest}"`
    : `The ${report.step} step`;
}

function side(owner: "backendCoding" | "frontendCoding"): string {
  return owner === "backendCoding" ? "backend" : "frontend";
}
