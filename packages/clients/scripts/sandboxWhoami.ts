/** Shows which Sandbox permissions the configured key has. Run: pnpm sandbox:whoami */
import { NebiusSandboxClient, type SandboxClient } from "../src/index.js";
import { requireEnv } from "./requireEnv.js";

const client: SandboxClient = new NebiusSandboxClient({
  token: requireEnv("NEBIUS_API_KEY"),
  project: requireEnv("NEBIUS_AI_PROJECT"),
  baseUrl: process.env.NEBIUS_SANDBOX_URL || undefined,
});

console.log(JSON.stringify(await client.whoAmI(), null, 2));
