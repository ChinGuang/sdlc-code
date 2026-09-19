/**
 * Runs the agent loop once against Token Factory with read-only repo tools.
 * Run: pnpm --filter @sdlc-code/core agent:smoke
 */
import { TokenFactoryChatClient } from "@sdlc-code/clients";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";
import { z } from "zod";
import {
  ChatAgentLoop,
  defineTool,
  NEMOTRON_SUPER,
  type AgentLoop,
} from "../src/index.js";

const apiKey = process.env.NEBIUS_API_KEY;
if (!apiKey) {
  console.error("Set NEBIUS_API_KEY in sdlc-code/.env (see .env.example)");
  process.exit(1);
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
/** Resolves a repo-relative path, refusing anything outside the repo or secret files. */
function inRepo(path: string): string {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel.startsWith("..") || /(^|[\\/])\.env/.test(rel))
    throw new Error(`not allowed: ${path}`);
  return full;
}

const listDir = defineTool({
  name: "list_dir",
  description: "List a directory of the sdlc-code repo (repo-relative path).",
  input: z.object({ path: z.string().describe('e.g. "packages/clients/src"') }),
  run: ({ path }) =>
    readdirSync(inRepo(path), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.name !== "node_modules" && !entry.name.startsWith(".env"),
      )
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .join("\n"),
});

const readFile = defineTool({
  name: "read_file",
  description: "Read a file of the sdlc-code repo (repo-relative path).",
  input: z.object({ path: z.string() }),
  run: ({ path }) => readFileSync(inRepo(path), "utf8"),
});

const loop: AgentLoop = new ChatAgentLoop({
  client: new TokenFactoryChatClient({
    apiKey,
    baseUrl: process.env.NEBIUS_BASE_URL || undefined,
  }),
  request: {
    model: process.env.SDLC_MODEL_BACKEND_CODING || NEMOTRON_SUPER,
    extra: { chat_template_kwargs: { enable_thinking: false } },
  },
  tools: [listDir, readFile],
  maxIterations: 8,
  transcript: {
    record: (event) => {
      if (event.type === "toolResult")
        console.log(`  tool ${event.name} → ${event.problem ?? "ok"}`);
      if (event.type === "assistant" && event.toolCalls.length > 0)
        console.log(
          `  model calls ${event.toolCalls.map((c) => `${c.name}(${c.arguments})`).join(", ")}`,
        );
    },
  },
});

const result = await loop.run({
  system:
    "You answer questions about a code repository by using the tools. Answer in one sentence.",
  user: "Which file defines the class TokenFactoryChatClient, and which HTTP path does its listModels method call?",
});

console.log(JSON.stringify(result, null, 2));
if (result.stopReason !== "answered") process.exitCode = 1;
