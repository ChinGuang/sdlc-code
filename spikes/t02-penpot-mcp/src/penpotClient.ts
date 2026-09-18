/**
 * Thin wrapper over the Penpot MCP tools used by the UI Design Agent.
 * Transport-agnostic: takes a `callTool` function (the MCP SDK client's callTool in production).
 */

export type ToolContent = { type: string; text?: string; data?: string; mimeType?: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

export type PenpotErrorKind = "suspended" | "disconnected" | "execution";

export class PenpotError extends Error {
  constructor(
    readonly kind: PenpotErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "PenpotError";
  }
}

export function classifyPenpotError(message: string): PenpotErrorKind {
  if (/suspended by the browser|no heartbeat/i.test(message)) return "suspended";
  if (/not connected|no .*plugin.*connected|plugin .*not (found|available)/i.test(message)) return "disconnected";
  return "execution";
}

const GUIDANCE: Record<Exclude<PenpotErrorKind, "execution">, string> = {
  suspended: "Penpot plugin tab is suspended. Focus the Penpot tab (keep it visible) and retry.",
  disconnected: "No Penpot plugin is connected. Open the Penpot file and start the MCP plugin.",
};

const FAILURE_PREFIX = /^Tool execution failed:/;

/** Strips Penpot MCP user tokens from any text before it is logged or stored. */
export function redactToken(text: string): string {
  return text.replace(/userToken=[^&\s"']+/g, "userToken=<redacted>");
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === "text" && c.text !== undefined)
    .map((c) => c.text)
    .join("\n");
}

export type PenpotClientOptions = {
  callTool: CallTool;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Delay before each retry while the tab is suspended. Retries only bridge a
   * brief refocus; if the user is away the error surfaces for Escalation.
   */
  retryDelaysMs?: number[];
};

export function createPenpotClient({ callTool, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelaysMs = [2000, 5000, 10000] }: PenpotClientOptions) {
  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    for (let attempt = 0; ; attempt++) {
      const result = await callTool(name, args);
      const message = textOf(result);
      // Penpot Cloud MCP reports failures as text without setting isError.
      if (!result.isError && !FAILURE_PREFIX.test(message)) return result;

      const kind = classifyPenpotError(message);
      if (kind === "execution") throw new PenpotError(kind, redactToken(message));
      // Only a suspended tab can come back on its own; a missing plugin needs a human now.
      const delay = kind === "suspended" ? retryDelaysMs[attempt] : undefined;
      if (delay === undefined) throw new PenpotError(kind, `${GUIDANCE[kind]} (${redactToken(message)})`);
      await sleep(delay);
    }
  }

  return {
    /** Runs Penpot plugin JavaScript and returns its `result` value. */
    async executeCode<T = unknown>(code: string): Promise<T> {
      const raw = textOf(await call("execute_code", { code }));
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      if (typeof parsed !== "object" || parsed === null || !("result" in parsed || "log" in parsed)) {
        throw new PenpotError("execution", `Unexpected execute_code response: ${redactToken(raw).slice(0, 200)}`);
      }
      return (parsed as { result?: T }).result as T;
    },

    async exportShape(shapeId: string, format: "png" | "svg" = "png"): Promise<{ bytes: Buffer; mimeType: string }> {
      const result = await call("export_shape", { shapeId, format });
      const image = result.content.find((c) => c.type === "image" && c.data);
      if (!image?.data) throw new PenpotError("execution", `export_shape returned no image for ${shapeId}`);
      return { bytes: Buffer.from(image.data, "base64"), mimeType: image.mimeType ?? `image/${format}` };
    },
  };
}

export type PenpotClient = ReturnType<typeof createPenpotClient>;
