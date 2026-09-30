import type { Finding } from "../agents/codeReview/findings.js";
import type { AgentLoopResult } from "../agentLoop/agentLoop.js";
import {
  storeContext,
  type StoreContext,
  type StoreOptions,
} from "./storeOptions.js";

/**
 * One review of a Run's diff (T19): every Finding the linters and the Code
 * Review Agent reported, and whether the agent got to the end. Kept so a
 * person at the PR Gate sees what was found, not only what reached the pull
 * request's description (T23).
 */
export type RunReviewRecord = {
  id: string;
  runId: string;
  findings: Finding[];
  stopReason: AgentLoopResult["stopReason"];
  /** What made the review less trustworthy than it looks. */
  problems: string[];
  createdAt: string;
};

export type NewReview = Pick<
  RunReviewRecord,
  "findings" | "stopReason" | "problems"
>;

/** A Run's reviews, oldest first: one per time it reached reviewing. */
export interface ReviewStore {
  saveReview: (runId: string, review: NewReview) => RunReviewRecord;
  listReviews: (runId: string) => RunReviewRecord[];
}

type ReviewRow = {
  id: string;
  run_id: string;
  findings: string;
  stop_reason: RunReviewRecord["stopReason"];
  problems: string;
  created_at: string;
};

export class SqliteReviewStore implements ReviewStore {
  #ctx: StoreContext;

  constructor(options: StoreOptions) {
    this.#ctx = storeContext(options);
  }

  saveReview = (runId: string, review: NewReview): RunReviewRecord => {
    const id = this.#ctx.newId();
    this.#ctx.db
      .prepare(
        "INSERT INTO reviews (id, run_id, findings, stop_reason, problems, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        runId,
        JSON.stringify(review.findings),
        review.stopReason,
        JSON.stringify(review.problems),
        this.#ctx.now(),
      );
    return this.listReviews(runId).find((one) => one.id === id)!;
  };

  listReviews = (runId: string): RunReviewRecord[] =>
    this.#ctx.db
      .prepare("SELECT * FROM reviews WHERE run_id = ? ORDER BY rowid")
      .all(runId)
      .map((row) => toReview(row as ReviewRow));
}

function toReview(row: ReviewRow): RunReviewRecord {
  return {
    id: row.id,
    runId: row.run_id,
    findings: JSON.parse(row.findings) as Finding[],
    stopReason: row.stop_reason,
    problems: JSON.parse(row.problems) as string[],
    createdAt: row.created_at,
  };
}
