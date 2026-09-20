import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { connectPenpotMcp } from "./connectPenpot.js";
import { PenpotError, type PenpotClient } from "./penpotClient.js";

/**
 * A stand-in for the Penpot MCP server: the same two tools, answering the way
 * the real one does (spike T02 finding 1: failures come back as plain text).
 */
function fakePenpotServer(options: { fail?: string } = {}) {
  const codes: string[] = [];
  const server = new McpServer({ name: "penpot", version: "1.0.0" });
  server.tool(
    "execute_code",
    { code: z.string() },
    ({ code }: { code: string }) => {
      codes.push(code);
      if (options.fail)
        return { content: [{ type: "text" as const, text: options.fail }] };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              result: { file: "sdlc-code runs" },
              log: "",
            }),
          },
        ],
      };
    },
  );
  server.tool(
    "export_shape",
    { shapeId: z.string(), format: z.string().optional() },
    () => ({
      content: [
        {
          type: "image" as const,
          data: Buffer.from("png-bytes").toString("base64"),
          mimeType: "image/png",
        },
      ],
    }),
  );
  return { server, codes };
}

/** Connects the real client to the fake server over a pair of in-memory transports. */
async function connectTo(fake: ReturnType<typeof fakePenpotServer>) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await fake.server.connect(serverTransport);
  return connectPenpotMcp({
    url: "https://design.penpot.app/mcp/stream?userToken=secret-token",
    createTransport: () => clientTransport,
  });
}

describe("connectPenpotMcp", () => {
  it("lists the server's tools and runs code through the Penpot client", async () => {
    const fake = fakePenpotServer();

    const connection = await connectTo(fake);
    // The connection is used through the interface, as callers do.
    const penpot: PenpotClient = connection.penpot;
    const file = await penpot.executeCode("return penpot.currentFile;");
    await connection.close();

    expect(connection.tools.sort()).toEqual(["execute_code", "export_shape"]);
    expect(file).toEqual({ file: "sdlc-code runs" });
    expect(fake.codes).toEqual(["return penpot.currentFile;"]);
  });

  it("exports a board as image bytes", async () => {
    const connection = await connectTo(fakePenpotServer());

    const image = await connection.penpot.exportShape("board-1");
    await connection.close();

    expect(image.mimeType).toBe("image/png");
    expect(image.bytes.toString()).toBe("png-bytes");
  });

  it("turns a disconnected plugin into a PenpotError with guidance", async () => {
    const connection = await connectTo(
      fakePenpotServer({
        fail: "Tool execution failed: Error: No Penpot plugin is connected.",
      }),
    );

    const error = await connection.penpot
      .executeCode("return 1;")
      .catch((problem: unknown) => problem);
    await connection.close();

    expect(error).toBeInstanceOf(PenpotError);
    expect(error).toMatchObject({ kind: "disconnected" });
    expect(String(error)).toMatch(
      /Open the Penpot file and start the MCP plugin/,
    );
  });

  it("reports a transport that will not connect, without the user token", async () => {
    const failing: Transport = {
      start: () =>
        Promise.reject(
          new Error("connect ECONNREFUSED userToken=secret-token"),
        ),
      send: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };

    const problem = await connectPenpotMcp({
      url: "https://design.penpot.app/mcp/stream?userToken=secret-token",
      createTransport: () => failing,
    }).catch((error: unknown) => error);

    expect(String(problem)).toMatch(
      /Could not connect to the Penpot MCP server/,
    );
    expect(String(problem)).not.toContain("secret-token");
  });
});
