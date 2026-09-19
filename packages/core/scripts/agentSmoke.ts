/**
 * Runs the agent loop once against Token Factory with read-only repo tools.
 * Run: pnpm --filter @sdlc-code/core agent:smoke
 */
import { TokenFactoryChatClient } from "@sdlc-code/clients";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ChatAgentLoop,
  defineTool,
  NEMOTRON_SUPER,
  requestOptionsFor,
  type AgentLoop,
} from "../src/index.js";

const apiKey = process.env.NEBIUS_API_KEY;
if (!apiKey) {
  console.error("Set NEBIUS_API_KEY in sdlc-code/.env (see .env.example)");
  process.exit(1);
}

const root = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The model may only see files git tracks. That excludes .env,
 * sdlc-code.config.json, databases, node_modules and .git without a blocklist,
 * which case-insensitive Windows paths and other drives can slip past.
 */
const tracked = new Set(
  execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean),
);
const normalise = (path: string) =>
  path
    .replaceAll("\\", "/")
    .replace(/^\.(\/|$)/, "")
    .replace(/\/+$/, "");
const MAX_FILE_CHARS = 20_000;

const listDir = defineTool({
  name: "list_dir",
  description: "List a directory of the sdlc-code repo (repo-relative path).",
  input: z.object({ path: z.string().describe('e.g. "packages/clients/src"') }),
  run: ({ path }) => {
    const dir = normalise(path);
    const prefix = dir === "" ? "" : `${dir}/`;
    const entries = new Set<string>();
    for (const file of tracked) {
      if (!file.startsWith(prefix)) continue;
      const [first, ...rest] = file.slice(prefix.length).split("/");
      entries.add(rest.length > 0 ? `${first}/` : first!);
    }
    if (entries.size === 0) throw new Error(`no tracked directory: ${path}`);
    return [...entries].sort().join("\n");
  },
});

const readFile = defineTool({
  name: "read_file",
  description: "Read a file of the sdlc-code repo (repo-relative path).",
  input: z.object({ path: z.string() }),
  run: ({ path }) => {
    const file = normalise(path);
    if (!tracked.has(file)) throw new Error(`not a tracked file: ${path}`);
    return readFileSync(`${root}/${file}`, "utf8").slice(0, MAX_FILE_CHARS);
  },
});

const loop: AgentLoop = new ChatAgentLoop({
  client: new TokenFactoryChatClient({
    apiKey,
    baseUrl: process.env.NEBIUS_BASE_URL || undefined,
  }),
  request: requestOptionsFor({
    model: process.env.SDLC_MODEL_BACKEND_CODING || NEMOTRON_SUPER,
    thinking: false,
    capabilities: { vision: false, penpotMcp: false },
  }),
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
