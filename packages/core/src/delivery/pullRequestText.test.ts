import { describe, expect, it } from "vitest";
import {
  pullRequestBody,
  pullRequestTitle,
  type RunOutcome,
} from "./pullRequestText.js";

const complete: RunOutcome = {
  outcome: "complete",
  runId: "run-1",
  requestTitle: "Todo app",
  summary: "A todo app with login.",
  slices: ["Walking Skeleton", "Todos CRUD"],
  findings: [
    {
      ruleId: "SC-4",
      location: "src/api/todos.ts:12",
      message: "Extract the date formatter into a pure helper.",
      suggestion: "Move it to src/format.ts.",
    },
  ],
};

const aborted: RunOutcome = {
  outcome: "aborted",
  runId: "run-2",
  requestTitle: "Todo app",
  summary: "A todo app with login.",
  passedSlices: ["Walking Skeleton"],
  stopReason: "Aborted by the developer at an Escalation.",
  totalSlices: 3,
  failedSlice: {
    name: "Todos CRUD",
    issueReports: ["POST /todos returns 500 when title is empty"],
  },
  workingMemory: "Validation middleware is missing on POST /todos.",
};

describe("pullRequestTitle", () => {
  it("uses the request title for a complete Run", () => {
    expect(pullRequestTitle(complete)).toBe("Todo app");
  });

  it("marks a stopped Run and how many Slices passed", () => {
    expect(pullRequestTitle(aborted)).toBe(
      "[Aborted] Todo app — 1 of 3 slices",
    );
    expect(pullRequestTitle({ ...aborted, outcome: "failed" })).toBe(
      "[Failed] Todo app — 1 of 3 slices",
    );
  });

  it("fits GitHub's 256-character title limit on one line", () => {
    const title = pullRequestTitle({
      ...complete,
      requestTitle: `Todo\napp ${"x".repeat(400)}`,
    });

    expect(title.length).toBeLessThanOrEqual(256);
    expect(title).not.toContain("\n");
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("pullRequestBody", () => {
  it("lists the summary, Slices and non-blocking Findings with Rule IDs", () => {
    const body = pullRequestBody(complete);

    expect(body).toContain("A todo app with login.");
    expect(body).toContain("- [x] Walking Skeleton");
    expect(body).toContain("- [x] Todos CRUD");
    expect(body).toContain(
      "- **SC-4** `src/api/todos.ts:12` — Extract the date formatter into a pure helper.",
    );
    expect(body).toContain("  Suggestion: Move it to src/format.ts.");
    expect(body).toContain("Opened by sdlc-code Run `run-1`.");
  });

  it("says so when there are no Findings", () => {
    expect(pullRequestBody({ ...complete, findings: [] })).toContain(
      "No non-blocking Findings.",
    );
  });

  it("reports a stopped Run: passed Slices, the failed Slice, its Issue Reports and Working Memory", () => {
    const body = pullRequestBody(aborted);

    expect(body).toMatch(/aborted.*1 of 3 slices/i);
    expect(body).toContain(
      "## Why it stopped\n\nAborted by the developer at an Escalation.",
    );
    expect(body).toContain("- [x] Walking Skeleton");
    expect(body).toContain("- [ ] Todos CRUD (not included)");
    expect(body).toContain("- POST /todos returns 500 when title is empty");
    expect(body).toContain("Validation middleware is missing on POST /todos.");
    expect(body).toContain("Only Slices that passed testing are included");
  });

  it("handles a stop before any Slice started", () => {
    const body = pullRequestBody({
      ...aborted,
      passedSlices: ["Walking Skeleton"],
      failedSlice: null,
    });

    expect(body).not.toContain("(not included)");
  });

  it("stops model-written text from @-mentioning people", () => {
    const body = pullRequestBody({
      ...complete,
      summary: "Thanks @octocat and @github/security",
    });

    expect(body).not.toMatch(/@octocat|@github/);
    expect(body).toContain("@​octocat");
  });

  it("fits GitHub's 65,536-character body limit", () => {
    const body = pullRequestBody({
      ...aborted,
      workingMemory: "m".repeat(100_000),
    });

    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain("(truncated)");
    expect(body.endsWith("Opened by sdlc-code Run `run-2`.")).toBe(true);
  });
});
