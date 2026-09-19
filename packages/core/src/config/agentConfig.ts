/**
 * Which model each agent role uses, whether it thinks, and what each model can accept
 * (Model Capabilities, CONTEXT.md). Defaults follow grilling Q5 and spike T03.
 *
 * Sources, lowest to highest precedence:
 *   built-in defaults → sdlc-code.config.json → SDLC_MODEL_<ROLE> env vars.
 */
import type { ChatRequest, ModelInfo } from "@sdlc-code/clients";
import { z } from "zod";
import { AGENT_ROLES, type AgentRole } from "../agentRoles.js";

/** Exact ids from Token Factory's model listing (they are case-sensitive). */
export const NEMOTRON_ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b";
export const NEMOTRON_SUPER = "nvidia/nemotron-3-super-120b-a12b";

export type ModelCapabilities = { vision: boolean; penpotMcp: boolean };

export type RoleSettings = {
  model: string;
  /** Reasoning on/off; off sends `enable_thinking: false` (spike T03 rule 7). */
  thinking: boolean;
  capabilities: ModelCapabilities;
};

export type AgentConfig = { roles: Record<AgentRole, RoleSettings> };

const DEFAULT_ROLES: Record<AgentRole, Omit<RoleSettings, "capabilities">> = {
  orchestrator: { model: NEMOTRON_ULTRA, thinking: true },
  systemDesign: { model: NEMOTRON_ULTRA, thinking: true },
  uiDesign: { model: NEMOTRON_SUPER, thinking: true },
  backendCoding: { model: NEMOTRON_SUPER, thinking: true },
  frontendCoding: { model: NEMOTRON_SUPER, thinking: true },
  // Mechanical tool loop (run tests, read results): thinking costs tokens for little gain.
  testing: { model: NEMOTRON_SUPER, thinking: false },
  codeReview: { model: NEMOTRON_ULTRA, thinking: true },
};

const NO_CAPABILITIES: ModelCapabilities = { vision: false, penpotMcp: false };

const RoleOverride = z.strictObject({
  model: z.string().min(1, "must be a non-empty model id").optional(),
  thinking: z.boolean().optional(),
});

const ConfigFile = z.strictObject({
  roles: z
    .strictObject(
      Object.fromEntries(
        AGENT_ROLES.map((role) => [role, RoleOverride.optional()]),
      ) as Record<AgentRole, z.ZodOptional<typeof RoleOverride>>,
    )
    .optional(),
  models: z
    .record(
      z.string(),
      z.strictObject({
        vision: z.boolean().optional(),
        penpotMcp: z.boolean().optional(),
      }),
    )
    .optional(),
});

export class AgentConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid agent config:\n- ${problems.join("\n- ")}`);
    this.name = "AgentConfigError";
    this.problems = problems;
  }
}

/** Env var that overrides a role's model, e.g. codeReview → SDLC_MODEL_CODE_REVIEW. */
export function modelEnvVar(role: AgentRole): string {
  return `SDLC_MODEL_${role.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

/**
 * Validates the (optional) parsed config file and merges it with defaults and env.
 * Throws AgentConfigError listing every problem.
 */
export function parseAgentConfig(
  file: unknown,
  env: Record<string, string | undefined>,
): AgentConfig {
  const parsed = ConfigFile.safeParse(file ?? {});
  if (!parsed.success) {
    throw new AgentConfigError(
      parsed.error.issues.map((issue) => {
        const path = issue.path.map(String).join(".") || "(root)";
        const message =
          issue.code === "unrecognized_keys"
            ? issue.keys.map((key) => `unrecognized key "${key}"`).join(", ")
            : issue.message;
        return `${path}: ${message}`;
      }),
    );
  }
  const { roles = {}, models = {} } = parsed.data;

  const resolved = Object.fromEntries(
    AGENT_ROLES.map((role) => {
      const model =
        env[modelEnvVar(role)] ||
        roles[role]?.model ||
        DEFAULT_ROLES[role].model;
      const settings: RoleSettings = {
        model,
        thinking: roles[role]?.thinking ?? DEFAULT_ROLES[role].thinking,
        capabilities: { ...NO_CAPABILITIES, ...models[model] },
      };
      return [role, settings];
    }),
  ) as Record<AgentRole, RoleSettings>;

  return { roles: resolved };
}

/** The ChatRequest fields a role contributes: its model and, if off, the thinking switch. */
export function requestOptionsFor(
  settings: RoleSettings,
): Pick<ChatRequest, "model" | "extra"> {
  return settings.thinking
    ? { model: settings.model }
    : {
        model: settings.model,
        extra: { chat_template_kwargs: { enable_thinking: false } },
      };
}

/** Checks every configured model against Token Factory's listing; returns problems. */
export function verifyAgentConfig(
  config: AgentConfig,
  offered: ModelInfo[],
): string[] {
  const byId = new Map(offered.map((model) => [model.id, model]));
  return AGENT_ROLES.flatMap((role) => {
    const { model } = config.roles[role];
    const info = byId.get(model);
    if (!info)
      return [`${role}: model "${model}" is not offered by Token Factory`];
    if (!info.features.includes("tools"))
      return [`${role}: model "${model}" does not support tool calling`];
    return [];
  });
}
