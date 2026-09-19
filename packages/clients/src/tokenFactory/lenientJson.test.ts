import { describe, expect, it } from "vitest";
import { parseJsonLeniently } from "./lenientJson.js";

describe("parseJsonLeniently", () => {
  it("parses valid JSON unchanged", () => {
    expect(parseJsonLeniently('{"a":[1,2]}')).toEqual({ a: [1, 2] });
  });

  it("drops an extra closing bracket at the end (seen live from Nemotron)", () => {
    expect(
      parseJsonLeniently(
        '[{"title":"Walking Skeleton","endpoints":["GET /health"]}]]',
      ),
    ).toEqual([{ title: "Walking Skeleton", endpoints: ["GET /health"] }]);
  });

  it("drops extra closers of either kind, with trailing whitespace", () => {
    expect(parseJsonLeniently('{"a":{"b":1}}}\n  ')).toEqual({ a: { b: 1 } });
  });

  it("adds missing closing brackets at the end", () => {
    expect(parseJsonLeniently('{"a":[{"b":"x"}')).toEqual({ a: [{ b: "x" }] });
  });

  it("ignores brackets inside strings when balancing", () => {
    expect(parseJsonLeniently('{"a":"]}{[","b":[1')).toEqual({
      a: "]}{[",
      b: [1],
    });
  });

  it("does not repair anything but the closers at the end", () => {
    expect(() => parseJsonLeniently('{"a":1,,"b":2}')).toThrow(SyntaxError);
    expect(() => parseJsonLeniently('{"a":"unterminated')).toThrow(SyntaxError);
    expect(() => parseJsonLeniently('{"a":[1}')).toThrow(SyntaxError);
  });

  it("repairs at most three closers", () => {
    expect(() => parseJsonLeniently('{"a":[[[[1')).toThrow(SyntaxError);
    expect(() => parseJsonLeniently("[1]]]]]")).toThrow(SyntaxError);
  });
});
