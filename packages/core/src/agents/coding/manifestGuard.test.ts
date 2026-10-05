// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { manifestChangeProblem } from "./manifestGuard.js";

const base = {
  name: "app",
  dependencies: { react: "^19.0.0", zod: "^3.24.1" },
  devDependencies: { vitest: "^2.1.8" },
  scripts: { test: "vitest run", "sdlc:test": "node scripts/sdlcTest.mjs" },
};

const manifest = (value: unknown) => JSON.stringify(value, null, 2);

describe("manifestChangeProblem", () => {
  it("allows a new dependency and a new script", () => {
    const after = {
      ...base,
      dependencies: { ...base.dependencies, "react-router-dom": "^7.1.1" },
      scripts: { ...base.scripts, "db:seed": "tsx seed.ts" },
    };

    expect(manifestChangeProblem(manifest(base), manifest(after))).toBeNull();
  });

  it("allows a manifest that changes nothing at all", () => {
    expect(manifestChangeProblem(manifest(base), manifest(base))).toBeNull();
  });

  // Seen live: vitest went to 0.30.1 beside a mock library needing vitest 2,
  // npm install failed with ERESOLVE and the Run escalated out with nothing.
  it("refuses a changed version of something already depended on", () => {
    const after = { ...base, devDependencies: { vitest: "0.30.1" } };

    expect(manifestChangeProblem(manifest(base), manifest(after))).toMatch(
      /devDependencies\.vitest was changed from \^2\.1\.8 to 0\.30\.1/,
    );
  });

  it("refuses a removal, and says what to do instead", () => {
    const after = { ...base, dependencies: { react: "^19.0.0" } };

    const problem = manifestChangeProblem(manifest(base), manifest(after));

    expect(problem).toContain("dependencies.zod was removed");
    expect(problem).toContain("Add a new entry if you need one");
  });

  it("refuses a rewritten script the test script depends on", () => {
    const after = {
      ...base,
      scripts: { ...base.scripts, test: "jest" },
    };

    expect(manifestChangeProblem(manifest(base), manifest(after))).toMatch(
      /scripts\.test was changed/,
    );
  });

  it("names every problem at once, so one reply fixes them all", () => {
    const after = {
      name: "app",
      dependencies: { react: "^18.0.0" },
      devDependencies: {},
      scripts: base.scripts,
    };

    const problem = manifestChangeProblem(manifest(base), manifest(after))!;

    expect(problem).toContain("dependencies.react was changed");
    expect(problem).toContain("dependencies.zod was removed");
    expect(problem).toContain("devDependencies.vitest was removed");
  });

  it("refuses anything that is not a JSON object", () => {
    expect(manifestChangeProblem(manifest(base), "{ broken")).toMatch(
      /must stay a JSON object/,
    );
    expect(manifestChangeProblem(manifest(base), "[]")).toMatch(
      /must stay a JSON object/,
    );
  });

  it("lets a broken manifest be replaced with a whole one", () => {
    expect(manifestChangeProblem("{ broken", manifest(base))).toBeNull();
  });
});
