import { describe, expect, it, vi } from "vitest";
import {
  classifyPenpotError,
  McpPenpotClient,
  PenpotError,
  redactToken,
  type CallTool,
  type PenpotClient,
  type PenpotClientOptions,
} from "./penpotClient.js";

// Tests depend on the interface; only this factory knows the class.
const makeClient = (options: PenpotClientOptions): PenpotClient =>
  new McpPenpotClient(options);

const text = (value: string, isError = false) => ({
  content: [{ type: "text", text: value }],
  isError,
});

describe("classifyPenpotError", () => {
  it("recognises a suspended plugin tab", () => {
    expect(
      classifyPenpotError(
        "The Penpot plugin tab appears to be suspended by the browser (no heartbeat for 39s).",
      ),
    ).toBe("suspended");
  });

  it("recognises a missing plugin connection", () => {
    expect(classifyPenpotError("No Penpot plugin instance is connected")).toBe(
      "disconnected",
    );
  });

  // Seen live: this ended a Run while the design was being drawn.
  it("recognises the connection Penpot loses when its tab closes", () => {
    expect(
      classifyPenpotError(
        "Tool execution failed: Error: No Penpot instance connected for user token. Please ensure that Penpot is connected.",
      ),
    ).toBe("disconnected");
  });

  // Seen live: export_shape returned Penpot's own 500 :timeout and ended a Run
  // whose design had already been drawn.
  it("recognises Penpot answering too slowly as something to retry", () => {
    expect(
      classifyPenpotError(
        'Tool execution failed: Error: Error handling task: http error ({:type :server-error, :code :timeout, :hint "ResourceRequest timed out", :uri "https://design.penpot.app/api/export", :status 500})',
      ),
    ).toBe("unavailable");
  });

  it("treats anything else as an execution error", () => {
    expect(
      classifyPenpotError(
        "Error handling task: Cannot read properties of undefined (reading 'bg')",
      ),
    ).toBe("execution");
  });
});

describe("PenpotClient.executeCode", () => {
  it("returns the result field of the tool's JSON output", async () => {
    const callTool: CallTool = vi.fn(async () =>
      text(JSON.stringify({ result: { id: "board-1" }, log: "" })),
    );
    const client = makeClient({ callTool });

    await expect(client.executeCode("return 1")).resolves.toEqual({
      id: "board-1",
    });
    expect(callTool).toHaveBeenCalledWith("execute_code", { code: "return 1" });
  });

  it("throws an execution PenpotError without retrying", async () => {
    const callTool: CallTool = vi.fn(async () =>
      text("Tool execution failed: Error: boom", true),
    );
    const client = makeClient({ callTool, sleep: async () => {} });

    await expect(client.executeCode("x")).rejects.toMatchObject({
      kind: "execution",
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("detects failures the server reports without isError (observed on Penpot Cloud MCP)", async () => {
    const callTool: CallTool = vi.fn(async () =>
      text(
        "Tool execution failed: Error: Error handling task: deliberate spike error",
      ),
    );
    const client = makeClient({ callTool, sleep: async () => {} });

    await expect(client.executeCode("throw 1")).rejects.toMatchObject({
      kind: "execution",
      message: expect.stringMatching(/deliberate spike error/),
    });
  });

  it("retries a suspended tab reported without isError", async () => {
    const callTool: CallTool = vi
      .fn()
      .mockResolvedValueOnce(
        text(
          "Tool execution failed: Error: The Penpot plugin tab appears to be suspended by the browser (no heartbeat for 41s).",
        ),
      )
      .mockResolvedValueOnce(text(JSON.stringify({ result: 2 })));
    const client = makeClient({
      callTool,
      sleep: async () => {},
      retryDelaysMs: [1],
    });

    await expect(client.executeCode("return 2")).resolves.toBe(2);
  });

  it("retries while the tab is suspended, then succeeds", async () => {
    const callTool: CallTool = vi
      .fn()
      .mockResolvedValueOnce(
        text(
          "The Penpot plugin tab appears to be suspended by the browser",
          true,
        ),
      )
      .mockResolvedValueOnce(text(JSON.stringify({ result: "ok" })));
    const sleep = vi.fn(async () => {});
    const client = makeClient({ callTool, sleep, retryDelaysMs: [5] });

    await expect(client.executeCode("x")).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledWith(5);
  });

  it("reports every wait, so a caller can ask for the tab to be focused", async () => {
    const callTool: CallTool = vi
      .fn()
      .mockResolvedValueOnce(
        text(
          "The Penpot plugin tab appears to be suspended by the browser",
          true,
        ),
      )
      .mockResolvedValueOnce(
        text(
          "The Penpot plugin tab appears to be suspended by the browser",
          true,
        ),
      )
      .mockResolvedValueOnce(text(JSON.stringify({ result: "ok" })));
    const waits: Array<{ attempt: number; delayMs: number; kind: string }> = [];
    const client = makeClient({
      callTool,
      sleep: async () => {},
      retryDelaysMs: [5, 10],
      onWaiting: (wait) => waits.push(wait),
    });

    await expect(client.executeCode("x")).resolves.toBe("ok");
    expect(waits).toEqual([
      { attempt: 1, delayMs: 5, kind: "suspended" },
      { attempt: 2, delayMs: 10, kind: "suspended" },
    ]);
  });

  // Seen live: a Run lost its design work when the plugin tab was closed.
  it("waits for a plugin tab that went away, then goes on", async () => {
    const callTool: CallTool = vi
      .fn()
      .mockResolvedValueOnce(
        text(
          "Tool execution failed: Error: No Penpot instance connected for user token.",
        ),
      )
      .mockResolvedValueOnce(text(JSON.stringify({ result: "ok" })));
    const waits: Array<{ attempt: number; delayMs: number; kind: string }> = [];
    const client = makeClient({
      callTool,
      sleep: async () => {},
      retryDelaysMs: [1, 1],
      onWaiting: (wait) => waits.push(wait),
    });

    await expect(client.executeCode("x")).resolves.toBe("ok");
    expect(waits).toEqual([{ attempt: 1, delayMs: 1, kind: "disconnected" }]);
  });

  it("retries an export Penpot was too busy to finish", async () => {
    const callTool: CallTool = vi
      .fn()
      .mockResolvedValueOnce(
        text(
          "Tool execution failed: Error: http error ({:code :timeout, :status 500})",
        ),
      )
      .mockResolvedValueOnce(text(JSON.stringify({ result: "ok" })));
    const waits: Array<{ kind: string }> = [];
    const client = makeClient({
      callTool,
      sleep: async () => {},
      retryDelaysMs: [1, 1],
      onWaiting: ({ kind }) => waits.push({ kind }),
    });

    await expect(client.executeCode("x")).resolves.toBe("ok");
    expect(waits).toEqual([{ kind: "unavailable" }]);
  });

  it("gives up on a plugin that never comes back, saying what to do", async () => {
    const callTool: CallTool = vi.fn(async () =>
      text("Tool execution failed: No Penpot plugin instance is connected"),
    );
    const client = makeClient({
      callTool,
      sleep: async () => {},
      retryDelaysMs: [1, 1],
    });

    await expect(client.executeCode("x")).rejects.toMatchObject({
      kind: "disconnected",
      message: expect.stringMatching(/start the MCP plugin/i),
    });
    expect(callTool).toHaveBeenCalledTimes(3);
  });

  it("returns undefined when the code returns nothing", async () => {
    const client = makeClient({
      callTool: async () => text(JSON.stringify({ log: "" })),
    });
    await expect(
      client.executeCode("penpot.createBoard()"),
    ).resolves.toBeUndefined();
  });

  it("rejects a success response that is not the expected JSON", async () => {
    const client = makeClient({
      callTool: async () => text("<html>gateway error</html>"),
    });
    await expect(client.executeCode("x")).rejects.toMatchObject({
      kind: "execution",
    });
  });

  it("gives up after the retry schedule with an actionable message", async () => {
    const callTool: CallTool = vi.fn(async () =>
      text("appears to be suspended by the browser", true),
    );
    const client = makeClient({
      callTool,
      sleep: async () => {},
      retryDelaysMs: [1, 1],
    });

    const error = await client.executeCode("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PenpotError);
    expect(error).toMatchObject({ kind: "suspended" });
    expect(String((error as Error).message)).toMatch(/focus the Penpot tab/i);
    expect(callTool).toHaveBeenCalledTimes(3);
  });
});

describe("PenpotClient.exportShape", () => {
  it("returns decoded PNG bytes from the image content", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const callTool: CallTool = vi.fn(async () => ({
      content: [
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      ],
    }));
    const client = makeClient({ callTool });

    const image = await client.exportShape("shape-1");
    expect(image.mimeType).toBe("image/png");
    expect([...image.bytes]).toEqual([...png]);
    expect(callTool).toHaveBeenCalledWith("export_shape", {
      shapeId: "shape-1",
      format: "png",
    });
  });

  it("throws when no image is returned", async () => {
    const client = makeClient({ callTool: async () => text("nothing") });
    await expect(client.exportShape("s")).rejects.toThrow(/no image/i);
  });
});

describe("redactToken", () => {
  it("removes userToken values wherever they appear", () => {
    const leaked =
      "fetch https://design.penpot.app/mcp/stream?userToken=abc.def-123 failed; retry ?userToken=abc.def-123&x=1";
    expect(redactToken(leaked)).toBe(
      "fetch https://design.penpot.app/mcp/stream?userToken=<redacted> failed; retry ?userToken=<redacted>&x=1",
    );
  });
});

describe("McpPenpotClient", () => {
  it("public methods work when passed as callbacks", async () => {
    const callTool: CallTool = vi.fn(async () =>
      text(JSON.stringify({ result: 7 })),
    );
    const { executeCode } = makeClient({ callTool });

    await expect(executeCode("return 7")).resolves.toBe(7);
  });

  it("does not expose its transport or retry settings", () => {
    const client = new McpPenpotClient({
      callTool: async () => text("{}"),
      retryDelaysMs: [1],
    });

    expect(Object.keys(client).sort()).toEqual(["executeCode", "exportShape"]);
    expect("callTool" in client).toBe(false);
    expect(JSON.stringify(client)).toBe("{}");
  });
});
