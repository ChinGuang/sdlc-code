/**
 * Prints each role's model, thinking and capabilities, and checks the models
 * against Token Factory. Run: pnpm --filter @sdlc-code/core config:check
 */
import { TokenFactoryChatClient } from "@sdlc-code/clients";
import { fileURLToPath } from "node:url";
import {
  AGENT_ROLES,
  loadAgentConfig,
  modelEnvVar,
  verifyAgentConfig,
} from "../src/index.js";

const configPath = fileURLToPath(
  new URL("../../../sdlc-code.config.json", import.meta.url),
);
const config = loadAgentConfig({ path: configPath, env: process.env });

console.table(
  Object.fromEntries(
    AGENT_ROLES.map((role) => {
      const { model, thinking, capabilities } = config.roles[role];
      return [
        role,
        {
          model,
          thinking,
          vision: capabilities.vision,
          penpotMcp: capabilities.penpotMcp,
          overrideEnv: modelEnvVar(role),
        },
      ];
    }),
  ),
);

const apiKey = process.env.NEBIUS_API_KEY;
if (!apiKey) {
  console.log(
    "NEBIUS_API_KEY not set: skipped checking models against Token Factory.",
  );
} else {
  const client = new TokenFactoryChatClient({
    apiKey,
    baseUrl: process.env.NEBIUS_BASE_URL || undefined,
  });
  const problems = verifyAgentConfig(config, await client.listModels());
  console.log(
    problems.length === 0
      ? "✓ All models are offered and support tool calling."
      : problems.join("\n"),
  );
  if (problems.length > 0) process.exitCode = 1;
}
