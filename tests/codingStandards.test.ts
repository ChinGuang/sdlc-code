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

  it("also applies to class expressions that implement an interface", async () => {
    const messages = await standardsViolations(`
      interface Api { run: () => void }
      export const Impl = class implements Api { run(): void {} };
    `);
    expect(messages).toEqual([expect.stringMatching(/^SC-3/)]);
  });

  it("does not flag a nested class that has no interface", async () => {
    const messages = await standardsViolations(`
      interface Api { run: () => unknown }
      export class Impl implements Api {
        run = () => class Helper { describe(): string { return "h"; } };
      }
    `);
    expect(messages).toEqual([]);
  });

  it("ignores protected and static methods (SC-3 covers public instance methods)", async () => {
    const messages = await standardsViolations(`
      interface Api { run: () => void }
      export class Impl implements Api {
        static create(): Impl { return new Impl(); }
        protected hook(): void {}
        run = (): void => this.hook();
      }
    `);
    expect(messages).toEqual([]);
  });
});

describe("SC-2 also covers abstract and accessor members", () => {
  it("rejects private abstract members", async () => {
    const messages = await standardsViolations(`
      export abstract class Base { private abstract secret(): string; }
    `);
    expect(messages).toEqual([expect.stringMatching(/^SC-2/)]);
  });

  it("rejects private accessor fields", async () => {
    const messages = await standardsViolations(`
      export class Client { private accessor token = "x"; }
    `);
    expect(messages).toEqual([expect.stringMatching(/^SC-2/)]);
  });
});

describe("SC-3 exception: NestJS controller handlers", () => {
  it("allows decorated handler methods on a @Controller class, even one that implements an interface", async () => {
    const messages = await standardsViolations(`
      declare function Controller(path?: string): ClassDecorator;
      declare function Get(path?: string): MethodDecorator;
      interface HealthApi { health: () => unknown }
      @Controller("health")
      export class HealthController implements HealthApi {
        @Get() health(): unknown { return {}; }
      }
    `);
    expect(messages).toEqual([]);
  });

  it("still requires arrow-function methods on an @Injectable service", async () => {
    const messages = await standardsViolations(`
      declare function Injectable(): ClassDecorator;
      interface Health { status: () => string }
      @Injectable()
      export class HealthService implements Health { status(): string { return "ok"; } }
    `);
    expect(messages).toEqual([expect.stringMatching(/^SC-3/)]);
  });

  it("still forbids TypeScript private constructor injection in a controller", async () => {
    const messages = await standardsViolations(`
      declare function Controller(path?: string): ClassDecorator;
      class HealthService {}
      @Controller("health")
      export class HealthController {
        constructor(private readonly health: HealthService) {}
      }
    `);
    expect(messages).toEqual([expect.stringMatching(/^SC-2/)]);
  });
});
