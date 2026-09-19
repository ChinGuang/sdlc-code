import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentConfigError, NEMOTRON_SUPER } from "./agentConfig.js";
import { loadAgentConfig, readConfigFile } from "./readConfigFile.js";

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

describe("loadAgentConfig", () => {
  it("combines the optional file with env overrides", () => {
    const path = join(dir, "sdlc-code.config.json");
    writeFileSync(path, '{ "roles": { "testing": { "thinking": true } } }');

    const config = loadAgentConfig({
      path,
      env: { SDLC_MODEL_CODE_REVIEW: "nvidia/custom" },
    });

    expect(config.roles.testing).toMatchObject({
      model: NEMOTRON_SUPER,
      thinking: true,
    });
    expect(config.roles.codeReview.model).toBe("nvidia/custom");
  });

  it("uses the defaults when there is no file", () => {
    const config = loadAgentConfig({ path: join(dir, "none.json"), env: {} });

    expect(config.roles.testing.thinking).toBe(false);
  });
});
