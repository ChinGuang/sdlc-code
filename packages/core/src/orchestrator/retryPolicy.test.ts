import { describe, expect, it } from "vitest";
import { issueReport } from "./fixtures/issueReport.js";
import { decideRetry, DEFAULT_RETRY_BUDGET } from "./retryPolicy.js";

const first = issueReport({ signature: "sig-a" });
const other = issueReport({
  signature: "sig-b",
  failingTest: "GET /todos > lists todos",
});

describe("decideRetry", () => {
  it("retries a new failure while both budgets allow", () => {
    expect(
      decideRetry({
        reports: [other],
        earlier: [first],
        retries: 1,
        tokensRemaining: 50_000,
      }),
    ).toEqual({ action: "retry" });
  });

  it("escalates a Loop at once, without spending the rest of the Retry Budget", () => {
    expect(
      decideRetry({
        reports: [issueReport({ signature: "sig-a" })],
        earlier: [first],
        retries: 1,
        tokensRemaining: 50_000,
      }),
    ).toEqual({
      action: "escalate",
      trigger: "loop",
      summary:
        "The same failure came back after a fix: POST /todos > rejects an empty title: AssertionError: expected 404 to be 400",
    });
  });

  it("reports a Loop before a spent budget: it is the more useful reason", () => {
    const decision = decideRetry({
      reports: [first],
      earlier: [first],
      retries: DEFAULT_RETRY_BUDGET,
      tokensRemaining: 0,
    });

    expect(decision).toMatchObject({ trigger: "loop" });
  });

  it("escalates when the Token Budget is spent", () => {
    expect(
      decideRetry({
        reports: [other],
        earlier: [],
        retries: 0,
        tokensRemaining: 0,
      }),
    ).toMatchObject({ action: "escalate", trigger: "tokenBudget" });
  });

  it("escalates after the default Retry Budget of 3", () => {
    const at = (retries: number) =>
      decideRetry({
        reports: [other],
        earlier: [],
        retries,
        tokensRemaining: 1,
      });

    expect(at(2)).toEqual({ action: "retry" });
    expect(at(3)).toEqual({
      action: "escalate",
      trigger: "retryBudget",
      summary: "Still failing after 3 retries: GET /todos > lists todos",
    });
  });

  it("uses a configured Retry Budget", () => {
    expect(
      decideRetry({
        reports: [other],
        earlier: [],
        retries: 1,
        retryBudget: 1,
        tokensRemaining: 1,
      }),
    ).toMatchObject({ trigger: "retryBudget" });
  });
});
