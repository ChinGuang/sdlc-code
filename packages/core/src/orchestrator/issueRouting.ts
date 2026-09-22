/**
 * One Test Run can fail in several ways at once; each Issue Report has its
 * Owner, and the Slice takes one next step (UML diagrams 6 and 7):
 *   an undecidable report    → escalate: a person decides
 *   a design agent owns one  → revise that document and re-open the Design Gate
 *                              (fixing code against a wrong document is wasted)
 *   otherwise                → each Coding Agent retries with its own reports
 */
import type { IssueReport } from "../agents/testing/issueReports.js";
import type { Owner, OwnerDecision } from "./ownerResolution.js";

export type RoutedReport = { report: IssueReport; decision: OwnerDecision };

type CodingOwner = Extract<Owner, "backendCoding" | "frontendCoding">;
type DesignOwner = Extract<Owner, "systemDesign" | "uiDesign">;

export type Route =
  | { kind: "escalate"; summary: string; reports: RoutedReport[] }
  | {
      kind: "reviseDocuments";
      /** Each design agent with the reports that show its document is wrong. */
      revisions: Array<{ owner: DesignOwner; reports: RoutedReport[] }>;
    }
  | {
      kind: "retryCoding";
      retries: Array<{ owner: CodingOwner; reports: RoutedReport[] }>;
    };

export function routeIssues(routed: readonly RoutedReport[]): Route {
  if (routed.length === 0)
    throw new Error("A failed Test Run must have at least one Issue Report.");
  const undecidable = routed.filter(
    ({ decision }) => decision.owner === "human",
  );
  if (undecidable.length > 0)
    return {
      kind: "escalate",
      summary: undecidable.map(({ decision }) => decision.reason).join(" "),
      reports: undecidable,
    };
  const byOwner = <O extends Owner>(owners: readonly O[]) =>
    owners.flatMap((owner) => {
      const reports = routed.filter(({ decision }) => decision.owner === owner);
      return reports.length > 0 ? [{ owner, reports }] : [];
    });
  const revisions = byOwner<DesignOwner>(["systemDesign", "uiDesign"]);
  if (revisions.length > 0) return { kind: "reviseDocuments", revisions };
  return {
    kind: "retryCoding",
    retries: byOwner<CodingOwner>(["backendCoding", "frontendCoding"]),
  };
}
