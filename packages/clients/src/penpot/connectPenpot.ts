/**
 * Connects to the Penpot MCP server (the plugin running in the user's browser)
 * over streamable HTTP. The URL embeds a user token, so it is never logged:
 * every error goes through redactToken.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  McpPenpotClient,
  redactToken,
  type CallTool,
  type PenpotClient,
  type ToolResult,
} from "./penpotClient.js";

export type PenpotConnection = {
  penpot: PenpotClient;
  /** The MCP tools the server offers, for a connectivity report. */
  tools: string[];
  close: () => Promise<void>;
};

export type ConnectPenpotOptions = {
  /** PENPOT_MCP_URL, e.g. https://design.penpot.app/mcp/stream?userToken=… */
  url: string;
  clientName?: string;
};

export async function connectPenpotMcp({
  url,
  clientName = "sdlc-code",
}: ConnectPenpotOptions): Promise<PenpotConnection> {
  const client = new Client({ name: clientName, version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(
      `Could not connect to the Penpot MCP server: ${redactToken(
        error instanceof Error ? error.message : String(error),
      )}`,
      { cause: error },
    );
  }
  const listed = await client.listTools();
  const callTool: CallTool = async (name, args) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return {
    penpot: new McpPenpotClient({ callTool }),
    tools: listed.tools.map((tool) => tool.name),
    close: () => client.close(),
  };
}
