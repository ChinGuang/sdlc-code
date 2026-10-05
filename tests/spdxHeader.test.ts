// SPDX-License-Identifier: MPL-2.0
/**
 * Proves the ESLint rule that keeps the licence line on every source file
 * (T26b) fires on a file without it, is quiet on one with it, and fixes.
 */
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd(), fix: true });

// The first lint loads eslint.config.js and the parser: pay it once, here.
beforeAll(() => lint("", "packages/core/src/__fixture__.ts"), 60_000);

const HEADER = "// SPDX-License-Identifier: MPL-2.0";

async function lint(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return {
    spdx: (result?.messages ?? []).filter((m) => m.ruleId === "spdx/header"),
    output: result?.output ?? code,
  };
}

describe("spdx/header", () => {
  it("is satisfied by the line at the top", async () => {
    const { spdx } = await lint(
      `${HEADER}\nexport const a = 1;\n`,
      "packages/core/src/__fixture__.ts",
    );
    expect(spdx).toEqual([]);
  });

  it("is satisfied below a shebang", async () => {
    const { spdx } = await lint(
      `#!/usr/bin/env node\n${HEADER}\nexport const a = 1;\n`,
      "apps/cli/src/__fixture__.ts",
    );
    expect(spdx).toEqual([]);
  });

  it.each([
    ["a TypeScript file", "packages/core/src/__fixture__.ts"],
    ["a React file", "apps/web/src/__fixture__.tsx"],
    ["a script", "packages/core/scripts/__fixture__.mjs"],
  ])("adds the line to %s that lacks it", async (_name, filePath) => {
    const { output } = await lint("export const a = 1;\n", filePath);
    expect(output).toBe(`${HEADER}\nexport const a = 1;\n`);
  });

  it("adds it below a shebang, not above", async () => {
    const { output } = await lint(
      "#!/usr/bin/env node\nexport const a = 1;\n",
      "apps/cli/src/__fixture__.ts",
    );
    expect(output).toBe(
      `#!/usr/bin/env node\n${HEADER}\nexport const a = 1;\n`,
    );
  });

  it("keeps a file's line endings when it adds the line", async () => {
    const { output } = await lint(
      "export const a = 1;\r\n",
      "packages/core/src/__fixture__.ts",
    );
    expect(output).toBe(`${HEADER}\r\nexport const a = 1;\r\n`);
  });

  it("does not take a different licence line for the right one", async () => {
    const { output } = await lint(
      "// SPDX-License-Identifier: GPL-3.0\nexport const a = 1;\n",
      "packages/core/src/__fixture__.ts",
    );
    expect(output.split("\n")[0]).toBe(HEADER);
  });

  it("leaves the template, which is shipped to generated apps, alone", async () => {
    const { spdx } = await lint(
      "export const a = 1;\n",
      "packages/stack-profiles/templates/react-node/src/__fixture__.ts",
    );
    expect(spdx).toEqual([]);
  });
});
