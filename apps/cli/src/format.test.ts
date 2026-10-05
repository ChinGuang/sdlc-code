// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import type { RunSummary } from "./api.js";
import { suggestedBudget } from "./cli.js";
import { PLAIN, runLine, statusText } from "./format.js";

describe("format", () => {
  // A newer server may know a status this client does not.
  it("shows a status it does not know, rather than failing", () => {
    expect(statusText("paused" as RunSummary["status"], PLAIN)).toBe("paused");
    expect(
      runLine(
        {
          id: "abcdef00",
          projectRequest: "x",
          mode: "gated",
          status: "paused" as RunSummary["status"],
          tokensUsed: 1,
          tokenBudget: 2,
          pullRequest: null,
          createdAt: "",
          updatedAt: "",
        },
        PLAIN,
      ),
    ).toMatch(/^abcdef {2}paused/);
  });

  it("suggests a budget above what was spent, even overspent", () => {
    expect(
      suggestedBudget({ tokensUsed: 2_005_052, tokenBudget: 2_000_000 }),
    ).toBe("3.1M");
    expect(
      suggestedBudget({ tokensUsed: 3_500_000, tokenBudget: 2_000_000 }),
    ).toBe("4.5M");
  });
});
