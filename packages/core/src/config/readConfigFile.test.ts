import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentConfigError } from "./agentConfig.js";
import { readConfigFile } from "./readConfigFile.js";

const dir = mkdtempSync(join(tmpdir(), "sdlc-code-config-"));

describe("readConfigFile", () => {
  it("returns undefined when the optional file does not exist", () => {
    expect(readConfigFile(join(dir, "missing.json"))).toBeUndefined();
  });

  it("returns the parsed JSON", () => {
    const path = join(dir, "ok.json");
    writeFileSync(path, '{ "roles": { "testing": { "thinking": true } } }');

    expect(readConfigFile(path)).toEqual({
      roles: { testing: { thinking: true } },
    });
  });

  it("reports invalid JSON as an AgentConfigError naming the file", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ roles: ");

    expect(() => readConfigFile(path)).toThrow(AgentConfigError);
    expect(() => readConfigFile(path)).toThrow(/bad\.json/);
  });
});
