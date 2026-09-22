import { describe, expect, it } from "vitest";
import { issueReport } from "./fixtures/issueReport.js";
import { routeIssues, type RoutedReport } from "./issueRouting.js";
import type { Owner } from "./ownerResolution.js";

const routed = (owner: Owner, signature: string = owner): RoutedReport => ({
  report: issueReport({ signature }),
  decision: {
    owner,
    rule:
      owner === "human"
        ? "undecidable"
        : owner === "backendCoding" || owner === "frontendCoding"
          ? "codeDeviates"
          : "documentsContradict",
    reason: `${owner} should fix it.`,
  },
});

describe("routeIssues", () => {
  it("retries each Coding Agent with only its own reports", () => {
    const route = routeIssues([
      routed("frontendCoding", "f1"),
      routed("backendCoding", "b1"),
      routed("backendCoding", "b2"),
    ]);

    expect(route.kind).toBe("retryCoding");
    if (route.kind !== "retryCoding") return;
    expect(
      route.retries.map(({ owner, reports }) => [
        owner,
        reports.map(({ report }) => report.signature),
      ]),
    ).toEqual([
      ["backendCoding", ["b1", "b2"]],
      ["frontendCoding", ["f1"]],
    ]);
  });

  it("revises documents before any code is fixed against them", () => {
    const route = routeIssues([
      routed("backendCoding"),
      routed("uiDesign"),
      routed("systemDesign"),
    ]);

    expect(route).toMatchObject({
      kind: "reviseDocuments",
      revisions: [{ owner: "systemDesign" }, { owner: "uiDesign" }],
    });
  });

  it("escalates when any report has no Owner, whatever else there is", () => {
    const route = routeIssues([
      routed("backendCoding"),
      routed("uiDesign"),
      routed("human"),
    ]);

    expect(route).toEqual({
      kind: "escalate",
      summary: "human should fix it.",
      reports: [routed("human")],
    });
  });

  it("refuses an empty list: a failed Test Run always has a report", () => {
    expect(() => routeIssues([])).toThrow(/at least one Issue Report/);
  });
});
