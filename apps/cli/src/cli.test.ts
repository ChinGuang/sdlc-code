import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    },
    out,
    err,
  };
}

describe("sdlccode", () => {
  it("prints the version", () => {
    const { io, out } = capture();
    expect(runCli(["--version"], io)).toBe(0);
    expect(out).toEqual(["sdlccode 0.0.0"]);
  });

  it("prints help with no arguments", () => {
    const { io, out } = capture();
    expect(runCli([], io)).toBe(0);
    expect(out.join("\n")).toMatch(/Usage: sdlccode/);
    // Commands are only listed once they exist (T24).
    expect(out.join("\n")).not.toMatch(/\brun\b/);
  });

  it("rejects unknown commands with exit code 2", () => {
    const { io, err } = capture();
    expect(runCli(["deploy"], io)).toBe(2);
    expect(err.join("\n")).toMatch(/Unknown command: deploy/);
  });
});
