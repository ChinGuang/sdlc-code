/**
 * Thin wrapper over the Penpot MCP tools used by the UI Design Agent.
 * Transport-agnostic: takes a `callTool` function (the MCP SDK client's callTool in production).
 */

export type ToolContent = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
};
export type ToolResult = { content: ToolContent[]; isError?: boolean };
export type CallTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

export type PenpotErrorKind = "suspended" | "disconnected" | "execution";

export class PenpotError extends Error {
  readonly kind: PenpotErrorKind;

  constructor(kind: PenpotErrorKind, message: string) {
    super(message);
    this.name = "PenpotError";
    this.kind = kind;
  }
}

export function classifyPenpotError(message: string): PenpotErrorKind {
  if (/suspended by the browser|no heartbeat/i.test(message))
    return "suspended";
  // Seen live: "No Penpot instance connected for user token" ended a Run when
  // the plugin tab was closed while the design was being drawn.
  if (
    /not connected|no [^.]*\bconnected\b|plugin .*not (found|available)/i.test(
      message,
    )
  )
    return "disconnected";
  return "execution";
}

const GUIDANCE: Record<Exclude<PenpotErrorKind, "execution">, string> = {
  suspended:
    "Penpot plugin tab is suspended. Focus the Penpot tab (keep it visible) and retry.",
  disconnected:
    "No Penpot plugin is connected. Open the Penpot file and start the MCP plugin.",
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
   * Delay before each retry while the tab is asleep or gone. A background tab
   * stays asleep until someone clicks it, so a caller that can ask for that
   * (the CLI, the dashboard) passes a longer schedule and reports each wait.
   */
  retryDelaysMs?: number[];
  /** Called before each wait, so the caller can ask the user to fix the tab. */
  onWaiting?: (wait: {
    attempt: number;
    delayMs: number;
    kind: Exclude<PenpotErrorKind, "execution">;
  }) => void;
};

export type ExportedImage = { bytes: Buffer; mimeType: string };

/** Penpot design operations used by the UI Design Agent. */
export interface PenpotClient {
  /** Runs Penpot plugin JavaScript and returns its `result` value. */
  executeCode: <T = unknown>(code: string) => Promise<T>;
  exportShape: (
    shapeId: string,
    format?: "png" | "svg",
  ) => Promise<ExportedImage>;
}

/** PenpotClient backed by the Penpot MCP server's tools. */
export class McpPenpotClient implements PenpotClient {
  #callTool: CallTool;
  #sleep: (ms: number) => Promise<void>;
  #retryDelaysMs: number[];
  #onWaiting: PenpotClientOptions["onWaiting"];

  constructor({
    callTool,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    retryDelaysMs = [2000, 5000, 10000],
    onWaiting,
  }: PenpotClientOptions) {
    this.#callTool = callTool;
    this.#sleep = sleep;
    this.#retryDelaysMs = retryDelaysMs;
    this.#onWaiting = onWaiting;
  }

  executeCode = async <T = unknown>(code: string): Promise<T> => {
    const raw = textOf(await this.#call("execute_code", { code }));
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("result" in parsed || "log" in parsed)
    ) {
      throw new PenpotError(
        "execution",
        `Unexpected execute_code response: ${redactToken(raw).slice(0, 200)}`,
      );
    }
    return (parsed as { result?: T }).result as T;
  };

  exportShape = async (
    shapeId: string,
    format: "png" | "svg" = "png",
  ): Promise<ExportedImage> => {
    const result = await this.#call("export_shape", { shapeId, format });
    const image = result.content.find((c) => c.type === "image" && c.data);
    if (!image?.data)
      throw new PenpotError(
        "execution",
        `export_shape returned no image for ${shapeId}`,
      );
    return {
      bytes: Buffer.from(image.data, "base64"),
      mimeType: image.mimeType ?? `image/${format}`,
    };
  };

  async #call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    for (let attempt = 0; ; attempt++) {
      const result = await this.#callTool(name, args);
      const message = textOf(result);
      // Penpot Cloud MCP reports failures as text without setting isError.
      if (!result.isError && !FAILURE_PREFIX.test(message)) return result;

      const kind = classifyPenpotError(message);
      if (kind === "execution")
        throw new PenpotError(kind, redactToken(message));
      // A sleeping tab wakes on a click and a closed one is reopened, so both
      // wait for the person instead of throwing away the Run's design work.
      const delay = this.#retryDelaysMs[attempt];
      if (delay === undefined)
        throw new PenpotError(
          kind,
          `${GUIDANCE[kind]} (${redactToken(message)})`,
        );
      this.#onWaiting?.({ attempt: attempt + 1, delayMs: delay, kind });
      await this.#sleep(delay);
    }
  }
}
