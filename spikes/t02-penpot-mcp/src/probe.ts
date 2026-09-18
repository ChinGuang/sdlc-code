/**
 * T02 live probe: Node MCP client → Penpot Cloud MCP → Penpot plugin in the browser.
 * Run: pnpm probe   (reads PENPOT_MCP_URL from ../../.env; the URL contains a user token and is never logged)
 * Writes results/probe-<ts>.json and results/board.png
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPenpotClient, type ToolResult } from "./penpotClient.js";

const envUrl = process.env.PENPOT_MCP_URL;
if (!envUrl) {
  console.error("Set PENPOT_MCP_URL in sdlc-code/.env");
  process.exit(1);
}
const url: string = envUrl;

const outDir = new URL("../results/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const findings: Record<string, unknown> = { startedAt: new Date().toISOString(), host: new URL(url).host };

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const started = Date.now();
  process.stdout.write(`▶ ${name} … `);
  try {
    const value = await fn();
    findings[name] = { ok: true, ms: Date.now() - started, value };
    console.log(`ok (${Date.now() - started} ms)`);
    return value;
  } catch (error) {
    findings[name] = { ok: false, ms: Date.now() - started, error: String(error).replace(url, "<PENPOT_MCP_URL>") };
    console.log(`FAILED: ${String(error).replace(url, "<PENPOT_MCP_URL>").slice(0, 300)}`);
    return undefined;
  }
}

const mcp = new Client({ name: "sdlc-code-spike-t02", version: "0.0.0" });
const penpot = createPenpotClient({
  callTool: async (name, args) => (await mcp.callTool({ name, arguments: args })) as ToolResult,
});

const CREATE_BOARD = `
const board = penpot.createBoard();
board.name = "sdlc-code T02 spike (safe to delete)";
board.resize(480, 200);
board.x = 20000; board.y = 20000;
board.fills = [{ fillColor: "#0B0F14", fillOpacity: 1 }];
const title = penpot.createText("Hello from sdlc-code via Penpot MCP");
title.fontSize = "24";
title.fills = [{ fillColor: "#76B900", fillOpacity: 1 }];
board.appendChild(title);
title.x = board.x + 24; title.y = board.y + 80;
return { boardId: board.id, page: penpot.currentPage.name };
`;

try {
  await step("connect", async () => {
    await mcp.connect(new StreamableHTTPClientTransport(new URL(url)));
    return mcp.getServerVersion();
  });

  await step("list_tools", async () => (await mcp.listTools()).tools.map((t) => t.name));

  await step("read_file_info", () =>
    penpot.executeCode(`return { file: penpot.currentFile?.name, pages: penpotUtils.getPages().map(p => p.name), current: penpot.currentPage.name }`),
  );

  // Latency of a trivial round-trip, 5 samples
  await step("roundtrip_latency_ms", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      await penpot.executeCode("return 1");
      samples.push(Date.now() - t);
    }
    return samples;
  });

  const created = await step("create_board_with_text", () => penpot.executeCode<{ boardId: string; page: string }>(CREATE_BOARD));

  if (created) {
    await step("export_png", async () => {
      const image = await penpot.exportShape(created.boardId, "png");
      writeFileSync(new URL("board.png", outDir), image.bytes);
      return { mimeType: image.mimeType, bytes: image.bytes.length };
    });

    await step("generate_markup_css", () =>
      penpot.executeCode(`const b = penpotUtils.findShapeById(${JSON.stringify(created.boardId)}); return penpot.generateStyle([b], { type: "css", withChildren: true }).slice(0, 600);`),
    );

    await step("execution_error_is_classified", async () => {
      try {
        await penpot.executeCode("throw new Error('deliberate spike error')");
        return "no error?";
      } catch (error) {
        return { kind: (error as { kind?: string }).kind, message: String(error).slice(0, 200) };
      }
    });

    await step("cleanup", () => penpot.executeCode(`penpotUtils.findShapeById(${JSON.stringify(created.boardId)})?.remove(); return "removed";`));
  }
} finally {
  await mcp.close().catch(() => {});
  findings.finishedAt = new Date().toISOString();
  writeFileSync(new URL(`probe-${Date.now()}.json`, outDir), JSON.stringify(findings, null, 2));
  console.log("\nwrote results/");
}
