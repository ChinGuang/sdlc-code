// SPDX-License-Identifier: MPL-2.0
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
    pushedCommits: 0,
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
    expect(body).toContain(
      "Only Slices that finished are included; nothing of Todos CRUD is.",
    );
    // The agents' notes are long and rough: folded away, not dropped.
    expect(body).toContain("<details>");
  });

  // T25d: a Slice that passed and was sent back keeps its commits on the branch.
  describe("a Slice that did not finish but whose commits are pushed", () => {
    const sentBack: RunOutcome = {
      ...aborted,
      passedSlices: ["Walking Skeleton", "Todos CRUD"],
      totalSlices: 3,
      failedSlice: { name: "Delete Todo", issueReports: [], pushedCommits: 3 },
    };

    it("says its code is in, instead of that it is not", () => {
      const body = pullRequestBody(sentBack);

      expect(body).toContain(
        "**Delete Todo** did not finish, but the 3 commits of it that passed testing are included.",
      );
      expect(body).toContain(
        "- [ ] Delete Todo (unfinished; 3 commits that passed testing included)",
      );
      expect(body).not.toContain("(not included)");
      expect(body).not.toContain("Only Slices that finished");
    });

    it("says so in the title", () => {
      expect(pullRequestTitle(sentBack)).toBe(
        "[Aborted] Todo app — 2 of 3 slices, 1 unfinished",
      );
    });

    it("says a single commit in the singular", () => {
      const body = pullRequestBody({
        ...sentBack,
        failedSlice: {
          name: "Delete Todo",
          issueReports: [],
          pushedCommits: 1,
        },
      });

      expect(body).toContain(
        "the 1 commit of it that passed testing is included",
      );
      expect(body).toContain(
        "(unfinished; 1 commit that passed testing included)",
      );
    });
  });

  it("says what it means when no Issue Report was recorded", () => {
    const body = pullRequestBody({
      ...aborted,
      failedSlice: { name: "Todos CRUD", issueReports: [], pushedCommits: 0 },
    });

    expect(body).toContain("No failing test was recorded for this Slice.");
    expect(body).not.toContain("None recorded");
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

  it("keeps the agents' notes inside their fold, cut or not", () => {
    const body = pullRequestBody({
      ...aborted,
      workingMemory: `</details> escaped? ${"m".repeat(100_000)}`,
    });

    expect(body).toContain("&lt;/details&gt; escaped?");
    expect(body.match(/<\/details>/g)).toHaveLength(1);
    expect(body.indexOf("(truncated)")).toBeLessThan(
      body.indexOf("</details>"),
    );
    expect(body.endsWith("Opened by sdlc-code Run `run-2`.")).toBe(true);
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
