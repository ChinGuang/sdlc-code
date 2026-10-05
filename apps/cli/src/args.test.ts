// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { parseArgs, parseTokens, UsageError } from "./args.js";
import { createSseParser, type SseMessage } from "./sse.js";

const VALUED = new Set(["repo", "budget"]);

describe("parseArgs", () => {
  it("splits words from switches and valued flags, either spelling", () => {
    expect(
      parseArgs(
        ["run", "Build it", "--repo", "o/r", "--budget=3M", "--auto"],
        VALUED,
      ),
    ).toEqual({
      words: ["run", "Build it"],
      flags: new Map<string, string | true>([
        ["repo", "o/r"],
        ["budget", "3M"],
        ["auto", true],
      ]),
    });
  });

  // A hint may start with a dash.
  it("takes everything after -- as words", () => {
    expect(
      parseArgs(
        ["escalation", "retry", "r", "--", "--verbose is wrong"],
        VALUED,
      ).words,
    ).toEqual(["escalation", "retry", "r", "--verbose is wrong"]);
  });

  it("refuses a valued flag with no value, and a switch given one", () => {
    expect(() => parseArgs(["run", "x", "--repo"], VALUED)).toThrow(UsageError);
    expect(() => parseArgs(["run", "x", "--repo", "--auto"], VALUED)).toThrow(
      /--repo needs a value/,
    );
    expect(() => parseArgs(["run", "x", "--auto=yes"], VALUED)).toThrow(
      /--auto takes no value/,
    );
  });
});

describe("parseTokens", () => {
  it.each([
    ["2000000", 2_000_000],
    ["2,000,000", 2_000_000],
    ["3M", 3_000_000],
    ["1.5m", 1_500_000],
    ["500k", 500_000],
  ])("reads %s", (text, tokens) => {
    expect(parseTokens(text)).toBe(tokens);
  });

  // "1,5M" is 1.5M in a decimal-comma locale, not 15M.
  it.each(["", "lots", "-5", "0", "2MB", "1,5M", "20,00,000"])(
    "refuses %j",
    (text) => {
      expect(() => parseTokens(text)).toThrow(UsageError);
    },
  );
});

describe("createSseParser", () => {
  it("reads named messages however the text is cut", () => {
    const messages: SseMessage[] = [];
    const feed = createSseParser((message) => messages.push(message));

    feed(": keep-alive\n\nid: 4");
    feed('1\nevent: status\ndata: {"a"');
    feed(":1}\n\nevent: tokens\r\ndata: 2\r\ndata: 3\r\n\r\n");

    expect(messages).toEqual([
      { event: "status", id: "41", data: '{"a":1}' },
      { event: "tokens", id: "41", data: "2\n3" },
    ]);
  });

  it("reads a CRLF cut between its CR and its LF as one line end", () => {
    const messages: SseMessage[] = [];
    const feed = createSseParser((message) => messages.push(message));

    feed("event: status\r");
    feed("\ndata: a\r");
    feed("\ndata: b\r\n\r\n");

    expect(messages).toEqual([{ event: "status", id: null, data: "a\nb" }]);
  });
});
