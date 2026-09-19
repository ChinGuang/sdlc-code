/**
 * Runs the System Design Agent once against Token Factory and writes the three
 * documents to a temp folder.
 *   pnpm --filter @sdlc-code/core design:smoke ["Project Request"]
 *   pnpm --filter @sdlc-code/core design:smoke --record   # also saves the model
 *     replies as the replay fixture used by systemDesignAgent.test.ts
 */
import { TokenFactoryChatClient } from "@sdlc-code/clients";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChatAgentLoop,
  designDocuments,
  loadAgentConfig,
  NemotronSystemDesignAgent,
  requestOptionsFor,
  type SystemDesignAgent,
  type TranscriptEvent,
} from "../src/index.js";

const apiKey = process.env.NEBIUS_API_KEY;
if (!apiKey) {
  console.error("Set NEBIUS_API_KEY in sdlc-code/.env (see .env.example)");
  process.exit(1);
}
const args = process.argv.slice(2);
const record = args.includes("--record");
const projectRequest =
  args.find((arg) => !arg.startsWith("--")) ??
  "Build a todo app where a user can add todos, mark them done and delete them.";

const config = loadAgentConfig({
  path: fileURLToPath(
    new URL("../../../sdlc-code.config.json", import.meta.url),
  ),
  env: process.env,
});
const settings = config.roles.systemDesign;
const client = new TokenFactoryChatClient({
  apiKey,
  baseUrl: process.env.NEBIUS_BASE_URL || undefined,
});
const replies: Array<Extract<TranscriptEvent, { type: "assistant" }>> = [];

const agent: SystemDesignAgent = new NemotronSystemDesignAgent({
  createLoop: (tools) =>
    new ChatAgentLoop({
      client,
      request: requestOptionsFor(settings),
      tools,
      maxIterations: 8,
      transcript: {
        record: (event) => {
          if (event.type === "assistant") {
            replies.push(event);
            const calls = event.toolCalls.map((call) => call.name).join(", ");
            console.log(`  model turn: ${calls || "answer"}`);
          }
          if (event.type === "toolResult")
            console.log(`  ${event.name}: ${event.content.split("\n")[0]}`);
        },
      },
    }),
});

console.log(
  `System Design Agent on ${settings.model} (thinking ${settings.thinking ? "on" : "off"})`,
);
const started = Date.now();
const { design, loop } = await agent.design({
  projectRequest,
  stackProfile:
    "React + Vite + Tailwind frontend; Node API with Prisma (SQLite in tests); Vitest.",
});
console.log(
  `${loop.stopReason} in ${loop.iterations} turns, ${((Date.now() - started) / 1000).toFixed(0)}s, ` +
    `${loop.usage.promptTokens} prompt + ${loop.usage.completionTokens} completion tokens`,
);

if (!design) {
  const dump = join(
    mkdtempSync(join(tmpdir(), "sdlc-design-failed-")),
    "replies.json",
  );
  writeFileSync(dump, JSON.stringify(replies, null, 2));
  console.error(`No design passed validation. Model replies: ${dump}`);
  console.error(loop.workingMemory);
  process.exit(1);
}
const out = mkdtempSync(join(tmpdir(), "sdlc-design-"));
for (const [kind, content] of Object.entries(designDocuments(design)))
  writeFileSync(
    join(out, kind === "systemDesign" ? `${kind}.md` : `${kind}.json`),
    content,
  );
console.log(`Documents written to ${out}`);
console.log(
  design.slicePlan
    .map(
      (slice, i) => `  ${i + 1}. ${slice.title}: ${slice.endpoints.join(", ")}`,
    )
    .join("\n"),
);

if (record) {
  const fixtures = fileURLToPath(
    new URL("../src/agents/systemDesign/fixtures/", import.meta.url),
  );
  mkdirSync(fixtures, { recursive: true });
  const file = join(fixtures, "recordedTodoRun.json");
  writeFileSync(
    file,
    `${JSON.stringify({ model: settings.model, projectRequest, replies }, null, 2)}\n`,
  );
  console.log(`Recorded ${replies.length} model replies to ${file}`);
}
