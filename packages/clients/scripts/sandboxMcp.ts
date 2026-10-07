// SPDX-License-Identifier: MPL-2.0
/**
 * The Sandbox as an MCP server on stdio (S6). An MCP client starts this process
 * and talks to it over stdin and stdout, so nothing else can reach it.
 *
 *   pnpm --filter @sdlc-code/clients sandbox:mcp
 *
 * Needs NEBIUS_API_KEY and NEBIUS_AI_PROJECT (NEBIUS_SANDBOX_URL is optional).
 * stdout carries the protocol and nothing else: everything this script says
 * goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSandboxMcpServer, NebiusSandboxClient } from "../src/index.js";

const token = process.env.NEBIUS_API_KEY;
const project = process.env.NEBIUS_AI_PROJECT;
if (!token || !project) {
  console.error(
    "sandbox:mcp needs NEBIUS_API_KEY and NEBIUS_AI_PROJECT (see .env.example).",
  );
  process.exit(1);
}

const server = createSandboxMcpServer({
  sandbox: new NebiusSandboxClient({
    token,
    project,
    baseUrl: process.env.NEBIUS_SANDBOX_URL || undefined,
    // A request the sandbox may have received is not sent again: a retried
    // run would start twice and count once against the limits.
    maxAttempts: 1,
  }),
  // What a command or an error may echo is taken out of what a client reads.
  secrets: [token],
});
await server.connect(new StdioServerTransport());
console.error("sdlc-code sandbox MCP server ready on stdio.");
