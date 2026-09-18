/** Lists NVIDIA models available to the configured key. Run: pnpm models:list */
import { TokenFactoryChatClient, type ChatClient } from "../src/index.js";
import { requireEnv } from "./requireEnv.js";

const client: ChatClient = new TokenFactoryChatClient({
  apiKey: requireEnv("NEBIUS_API_KEY"),
  baseUrl: process.env.NEBIUS_BASE_URL || undefined,
});

const models = await client.listModels();
console.table(
  models
    .filter((m) => m.id.toLowerCase().startsWith("nvidia/"))
    .map((m) => ({
      id: m.id,
      context: m.contextLength,
      "$/M in": m.pricing?.promptPerMillion,
      "$/M out": m.pricing?.completionPerMillion,
      features: m.features.join(", "),
    })),
);
