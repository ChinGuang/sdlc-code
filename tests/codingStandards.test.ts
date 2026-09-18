/**
 * Proves the ESLint rules that enforce CODING_STANDARDS.md (SC-2, SC-3)
 * fire on violations and stay quiet on compliant code.
 */
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });

async function standardsViolations(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: "packages/core/src/__fixture__.ts",
  });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => m.message);
}

describe("SC-2 private state uses #private", () => {
  it("rejects TypeScript private fields", async () => {
    const messages = await standardsViolations(`
      export class Client { private token = "x"; }
    `);
    expect(messages).toEqual([expect.stringMatching(/^SC-2/)]);
  });

  it("rejects TypeScript private methods", async () => {
    const messages = await standardsViolations(`
      export class Client { private helper(): void {} }
    `);
    expect(messages).toEqual([expect.stringMatching(/^SC-2/)]);
  });

  it("rejects parameter properties", async () => {
    const messages = await standardsViolations(`
      export class AppError extends Error {
        constructor(readonly status: number) { super(); }
      }
    `);
    expect(messages).toEqual([expect.stringMatching(/^SC-2/)]);
  });

  it("accepts #private fields and methods", async () => {
    const messages = await standardsViolations(`
      export class Client {
        #token = "x";
        #helper(): string { return this.#token; }
      }
    `);
    expect(messages).toEqual([]);
  });
});

describe("SC-3 public methods are arrow-function properties", () => {
  it("rejects a regular public method on a class that implements an interface", async () => {
    const messages = await standardsViolations(`
      interface Api { run: () => void }
      export class Impl implements Api { run(): void {} }
    `);
    expect(messages).toEqual([expect.stringMatching(/^SC-3/)]);
  });

  it("accepts arrow-function properties, constructors, getters and #private methods", async () => {
    const messages = await standardsViolations(`
      interface Api { run: () => void }
      export class Impl implements Api {
        #count = 0;
        constructor() {}
        get count(): number { return this.#count; }
        run = (): void => { this.#bump(); };
        #bump(): void { this.#count++; }
      }
    `);
    expect(messages).toEqual([]);
  });

  it("does not apply to classes without an interface (e.g. errors)", async () => {
    const messages = await standardsViolations(`
      export class AppError extends Error { override toString(): string { return "x"; } }
    `);
    expect(messages).toEqual([]);
  });
});
