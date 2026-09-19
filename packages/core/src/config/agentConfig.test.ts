import type { ModelInfo } from "@sdlc-code/clients";
import { describe, expect, it } from "vitest";
import {
  AgentConfigError,
  NEMOTRON_SUPER,
  NEMOTRON_ULTRA,
  parseAgentConfig,
  requestOptionsFor,
  verifyAgentConfig,
} from "./agentConfig.js";

describe("parseAgentConfig defaults", () => {
  it("uses Ultra for reasoning roles and Super for tool-heavy roles (grilling Q5, spike T03)", () => {
    const { roles } = parseAgentConfig(undefined, {});

    expect(roles.orchestrator.model).toBe(NEMOTRON_ULTRA);
    expect(roles.systemDesign.model).toBe(NEMOTRON_ULTRA);
    expect(roles.codeReview.model).toBe(NEMOTRON_ULTRA);
    expect(roles.uiDesign.model).toBe(NEMOTRON_SUPER);
    expect(roles.backendCoding.model).toBe(NEMOTRON_SUPER);
    expect(roles.frontendCoding.model).toBe(NEMOTRON_SUPER);
    expect(roles.testing.model).toBe(NEMOTRON_SUPER);
  });

  it("turns thinking off only for the mechanical Testing role (spike T03 rule 7)", () => {
    const { roles } = parseAgentConfig(undefined, {});

    expect(roles.testing.thinking).toBe(false);
    expect(roles.codeReview.thinking).toBe(true);
    expect(roles.backendCoding.thinking).toBe(true);
  });

  it("gives every model no extra capabilities unless configured", () => {
    const { roles } = parseAgentConfig(undefined, {});

    expect(roles.frontendCoding.capabilities).toEqual({
      vision: false,
      penpotMcp: false,
    });
  });
});

describe("parseAgentConfig overrides", () => {
  it("applies per-role overrides and per-model capabilities from the config file", () => {
    const { roles } = parseAgentConfig(
      {
        roles: {
          frontendCoding: { model: "nvidia/Nemotron-3-Ultra-550b-a55b" },
          testing: { thinking: true },
        },
        models: { "nvidia/Nemotron-3-Ultra-550b-a55b": { penpotMcp: true } },
      },
      {},
    );

    expect(roles.frontendCoding).toEqual({
      model: NEMOTRON_ULTRA,
      thinking: true,
      capabilities: { vision: false, penpotMcp: true },
    });
    // Capabilities belong to the model, so every role using it gets them.
    expect(roles.orchestrator.capabilities.penpotMcp).toBe(true);
    expect(roles.testing.thinking).toBe(true);
  });

  it("lets an environment variable override a role's model (SDLC_MODEL_<ROLE>)", () => {
    const { roles } = parseAgentConfig(
      { roles: { codeReview: { model: "from/file" } } },
      { SDLC_MODEL_CODE_REVIEW: "from/env", SDLC_MODEL_BACKEND_CODING: "" },
    );

    expect(roles.codeReview.model).toBe("from/env");
    expect(roles.backendCoding.model).toBe(NEMOTRON_SUPER); // empty value is ignored
  });
});

describe("parseAgentConfig validation", () => {
  it("rejects unknown roles, wrong types and empty model ids with readable messages", () => {
    const attempt = () =>
      parseAgentConfig(
        {
          roles: {
            subagent: { model: "x" },
            testing: { model: "", thinking: "yes" },
          },
          models: { "nvidia/x": { vision: "true" } },
        },
        {},
      );

    expect(attempt).toThrow(AgentConfigError);
    const message = (() => {
      try {
        attempt();
      } catch (error) {
        return String((error as Error).message);
      }
      return "";
    })();
    expect(message).toMatch(/roles: unrecognized key "subagent"/i);
    expect(message).toMatch(/roles\.testing\.model/);
    expect(message).toMatch(/roles\.testing\.thinking/);
    expect(message).toMatch(/models\.nvidia\/x\.vision/);
  });

  it("rejects a config that is not an object", () => {
    expect(() => parseAgentConfig("ultra please", {})).toThrow(
      AgentConfigError,
    );
  });
});

describe("requestOptionsFor", () => {
  it("adds nothing when thinking is on and disables it via chat_template_kwargs when off", () => {
    const { roles } = parseAgentConfig(undefined, {});

    expect(requestOptionsFor(roles.codeReview)).toEqual({
      model: NEMOTRON_ULTRA,
    });
    expect(requestOptionsFor(roles.testing)).toEqual({
      model: NEMOTRON_SUPER,
      extra: { chat_template_kwargs: { enable_thinking: false } },
    });
  });
});

describe("verifyAgentConfig", () => {
  const model = (id: string, features: string[] = ["tools"]): ModelInfo => ({
    id,
    contextLength: 262144,
    pricing: null,
    features,
  });

  it("passes when every configured model is offered and supports tools", () => {
    const config = parseAgentConfig(undefined, {});

    expect(
      verifyAgentConfig(config, [model(NEMOTRON_ULTRA), model(NEMOTRON_SUPER)]),
    ).toEqual([]);
  });

  it("reports models that are missing (ids are case-sensitive) or lack tool calling", () => {
    const config = parseAgentConfig(
      { roles: { testing: { model: "nvidia/no-tools" } } },
      {},
    );

    const problems = verifyAgentConfig(config, [
      model(NEMOTRON_ULTRA.toLowerCase()),
      model(NEMOTRON_SUPER),
      model("nvidia/no-tools", []),
    ]);

    expect(problems).toEqual([
      `orchestrator: model "${NEMOTRON_ULTRA}" is not offered by Token Factory`,
      `systemDesign: model "${NEMOTRON_ULTRA}" is not offered by Token Factory`,
      `testing: model "nvidia/no-tools" does not support tool calling`,
      `codeReview: model "${NEMOTRON_ULTRA}" is not offered by Token Factory`,
    ]);
  });
});
