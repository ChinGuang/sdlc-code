/**
 * Runs the whole Design Phase once against the real services: the System Design
 * Agent on Token Factory, then the UI Design Agent, which draws the screens on
 * the Run's page in your Penpot file.
 *
 * Needs the Penpot tab open with the MCP plugin connected (PENPOT_MCP_URL).
 *   pnpm --filter @sdlc-code/core design-phase:smoke ["Project Request"]
 */
import {
  connectPenpotMcp,
  TokenFactoryChatClient,
  type ChatClient,
} from "@sdlc-code/clients";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChatAgentLoop,
  designDocuments,
  loadAgentConfig,
  LoopSystemDesignAgent,
  LoopUiDesignAgent,
  PenpotUiCanvas,
  requestOptionsFor,
  runPageName,
  type AgentLoop,
  type AgentTool,
  type AgentRole,
  type TranscriptEvent,
} from "../src/index.js";

const apiKey = process.env.NEBIUS_API_KEY;
const penpotUrl = process.env.PENPOT_MCP_URL;
for (const [name, value] of [
  ["NEBIUS_API_KEY", apiKey],
  ["PENPOT_MCP_URL", penpotUrl],
] as const)
  if (!value) {
    console.error(`Set ${name} in sdlc-code/.env (see .env.example)`);
    process.exit(1);
  }

const projectRequest =
  process.argv[2] ??
  "Build a todo app where a user can add todos, mark them done and delete them.";
const config = loadAgentConfig({
  path: fileURLToPath(
    new URL("../../../sdlc-code.config.json", import.meta.url),
  ),
  env: process.env,
});
const client: ChatClient = new TokenFactoryChatClient({
  apiKey: apiKey!,
  baseUrl: process.env.NEBIUS_BASE_URL || undefined,
});

const loopFor =
  (role: AgentRole, maxIterations: number) =>
  (tools: AgentTool[]): AgentLoop =>
    new ChatAgentLoop({
      client,
      request: requestOptionsFor(config.roles[role]),
      tools,
      maxIterations,
      transcript: {
        record: (event: TranscriptEvent) => {
          if (event.type === "assistant")
            console.log(
              `  ${role}: ${event.toolCalls.map((call) => call.name).join(", ") || "answer"}`,
            );
          if (event.type === "toolResult")
            console.log(
              `    ${event.name}: ${event.content.slice(0, 200).replaceAll("\n", " | ")}`,
            );
        },
      },
    });

const started = Date.now();
console.log(`System Design Agent on ${config.roles.systemDesign.model}`);
const { design, loop: designLoop } = await new LoopSystemDesignAgent({
  createLoop: loopFor("systemDesign", 12),
}).design({
  projectRequest,
  stackProfile:
    "React + Vite + Tailwind frontend; Node API with Prisma (SQLite in tests); Vitest.",
});
if (!design) {
  console.error(`No design passed validation: ${designLoop.workingMemory}`);
  process.exit(1);
}

const out = mkdtempSync(join(tmpdir(), "sdlc-design-phase-"));
for (const [kind, content] of Object.entries(designDocuments(design)))
  writeFileSync(
    join(out, kind === "systemDesign" ? `${kind}.md` : `${kind}.json`),
    content,
  );

console.log("Connecting to Penpot…");
const penpot = await connectPenpotMcp({ url: penpotUrl! });
const canvas = new PenpotUiCanvas(penpot.penpot);
const connection = await canvas.checkConnection();
console.log(
  `Penpot file "${connection.file}" (tools: ${penpot.tools.join(", ")})`,
);

const pageName = runPageName("#smoke", projectRequest);
console.log(
  `UI Design Agent on ${config.roles.uiDesign.model}, page "${pageName}"`,
);
try {
  const { spec, screens, loop } = await new LoopUiDesignAgent({
    canvas,
    createLoop: loopFor("uiDesign", 10),
  }).design({
    projectRequest,
    pageName,
    slicePlan: design.slicePlan,
    apiContract: design.apiContract,
  });

  if (spec) {
    writeFileSync(
      join(out, "uiSpec.json"),
      `${JSON.stringify(spec, null, 2)}\n`,
    );
    for (const screen of screens)
      if (screen.export)
        writeFileSync(
          join(out, `${screen.name.replaceAll(/[^\w-]+/g, "-")}.png`),
          screen.export.bytes,
        );
    console.log(
      screens
        .map((screen) => `  ${screen.name}: board ${screen.boardId}`)
        .join("\n"),
    );
  } else {
    console.error(`No UI Spec passed validation: ${loop.workingMemory}`);
    process.exitCode = 1;
  }
  const tokens =
    designLoop.usage.promptTokens +
    designLoop.usage.completionTokens +
    loop.usage.promptTokens +
    loop.usage.completionTokens;
  console.log(
    `Done in ${((Date.now() - started) / 1000).toFixed(0)}s, ${tokens} tokens. Files: ${out}`,
  );
} finally {
  await penpot.close();
}
