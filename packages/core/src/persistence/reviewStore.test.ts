import { describe, expect, it } from "vitest";
import type { Finding } from "../agents/codeReview/findings.js";
import { SqliteReviewStore, type ReviewStore } from "./reviewStore.js";
import { databaseWithRun } from "./testDatabase.js";

// Tests depend on the interface; only this factory knows the class.
function setup(): { store: ReviewStore; runId: string } {
  const { runId, options } = databaseWithRun();
  return { store: new SqliteReviewStore(options), runId };
}

const FINDING: Finding = {
  ruleId: "SEC-01",
  file: "src/server/app.ts",
  line: 3,
  message: "The API key is in the source.",
  suggestion: "Read it from the environment.",
  severity: "blocking",
  source: "codeReview",
};

describe("SqliteReviewStore", () => {
  it("keeps each review's Findings, as they were found", () => {
    const { store, runId } = setup();

    const saved = store.saveReview(runId, {
      findings: [FINDING],
      stopReason: "answered",
      problems: ["eslint could not run"],
    });

    expect(saved).toMatchObject({
      runId,
      findings: [FINDING],
      stopReason: "answered",
      problems: ["eslint could not run"],
    });
    expect(store.listReviews(runId)).toEqual([saved]);
  });

  // A blocking Finding sends the code back, so a Run is reviewed again.
  it("lists a Run's reviews oldest first", () => {
    const { store, runId } = setup();

    store.saveReview(runId, {
      findings: [FINDING],
      stopReason: "answered",
      problems: [],
    });
    store.saveReview(runId, {
      findings: [],
      stopReason: "answered",
      problems: [],
    });

    expect(store.listReviews(runId).map((review) => review.findings)).toEqual([
      [FINDING],
      [],
    ]);
  });

  it("has no reviews for a Run that was never reviewed", () => {
    const { store, runId } = setup();

    expect(store.listReviews(runId)).toEqual([]);
  });
});
