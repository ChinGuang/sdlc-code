import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redactSecrets.js";

describe("redactSecrets", () => {
  it("replaces every occurrence of each secret", () => {
    expect(redactSecrets("a s1 b s2 s1", ["s1", "s2"])).toBe(
      "a [redacted] b [redacted] [redacted]",
    );
  });

  it("ignores empty secrets", () => {
    expect(redactSecrets("text", [""])).toBe("text");
  });
});
