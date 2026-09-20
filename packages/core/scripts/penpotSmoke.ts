/**
 * Draws a fixed UI Spec on its own page in your Penpot file, without the model:
 * checks the MCP connection, the renderer and the exports.
 * Needs the Penpot tab open with the MCP plugin connected (PENPOT_MCP_URL).
 *   pnpm --filter @sdlc-code/core penpot:smoke [pageSuffix]
 */
import { connectPenpotMcp } from "@sdlc-code/clients";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goodUiSpec } from "../src/agents/uiDesign/fixtures/goodUiSpec.js";
import { PenpotUiCanvas, runPageName, type UiCanvas } from "../src/index.js";

const url = process.env.PENPOT_MCP_URL;
if (!url) {
  console.error("Set PENPOT_MCP_URL in sdlc-code/.env (see .env.example)");
  process.exit(1);
}

const spec = goodUiSpec();
const pageName = runPageName(
  `#penpot-smoke${process.argv[2] ? `-${process.argv[2]}` : ""}`,
  "Todo app",
);
const started = Date.now();
const connection = await connectPenpotMcp({ url });
const canvas: UiCanvas = new PenpotUiCanvas(connection.penpot);

try {
  const file = await canvas.checkConnection();
  console.log(
    `Connected to "${file.file}" (tools: ${connection.tools.join(", ")})`,
  );

  const page = await canvas.ensurePage(pageName);
  console.log(`Page "${pageName}" ${page.created ? "created" : "reused"}`);

  const out = mkdtempSync(join(tmpdir(), "sdlc-penpot-"));
  for (const [index, screen] of spec.screens.entries()) {
    const board = await canvas.drawScreen({
      pageName,
      index,
      screen,
      tokens: spec.tokens,
    });
    const image = await canvas.exportBoard(board.boardId);
    const file = join(out, `${screen.name.replaceAll(/[^\w-]+/g, "-")}.png`);
    writeFileSync(file, image.bytes);
    console.log(
      `  ${board.name}: ${image.bytes.length} bytes ${image.mimeType} → ${file}`,
    );
  }
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
} finally {
  await connection.close();
}
