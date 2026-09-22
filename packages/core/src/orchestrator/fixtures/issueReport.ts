/** Test helper: an Issue Report with the fields a test cares about. */
import type { IssueReport } from "../../agents/testing/issueReports.js";

export function issueReport(fields: Partial<IssueReport> = {}): IssueReport {
  return {
    step: "unit",
    failingTest: "POST /todos > rejects an empty title",
    file: "server/todos.test.ts",
    endpoint: "POST /todos",
    error: "AssertionError: expected 404 to be 400",
    evidence: "AssertionError: expected 404 to be 400",
    suspectedOwner: "backendCoding",
    signature: "sig-post-todos",
    occurrences: 1,
    ...fields,
  };
}
