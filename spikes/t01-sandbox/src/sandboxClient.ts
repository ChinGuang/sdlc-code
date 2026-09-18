/**
 * Minimal client for Nebius Token Factory Sandboxes (ConTree API).
 * Spike quality: covers only what a Test Run needs.
 * API reference: https://docs.tokenfactory.nebius.com/api-reference/sandboxes
 */

export const DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/sandboxes/v1";

export type StreamRepr = { value: string; encoding: "ascii" | "base64"; truncated?: boolean };

export type InstanceResult = {
  state?: { exit_code?: number; timed_out?: boolean; signal?: number };
  stdout?: StreamRepr;
  stderr?: StreamRepr;
  resources?: { cost?: number; elapsed_time?: number };
};

export type OperationStatus = "PENDING" | "ASSIGNED" | "EXECUTING" | "SUCCESS" | "FAILED" | "CANCELLED";

export type OperationResponse = {
  uuid: string;
  kind: "image_import" | "instance";
  status: OperationStatus;
  error?: string | null;
  duration?: number | null;
  image_uuid?: string | null;
  result_image_uuid?: string | null;
  metadata?: { result?: InstanceResult | null };
  result?: { image?: string | null; tag?: string | null };
};

export type FileRef = { uuid: string; mode?: string; uid?: number; gid?: number };

export type SpawnRequest = {
  /** Image UUID, or `tag:<name>` */
  image: string;
  command: string;
  shell?: boolean;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  disposable?: boolean;
  networking?: { enabled: boolean };
  files?: Record<string, FileRef>;
  truncate_output_at?: number;
};

export type RunResult = {
  operationId: string;
  status: OperationStatus;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  resultImage: string | null;
  durationSeconds: number | null;
  cost: number | null;
  error: string | null;
};

export type SandboxClientOptions = {
  token: string;
  project: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const TERMINAL: ReadonlySet<OperationStatus> = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

export function decodeStream(stream: StreamRepr | undefined): string {
  if (!stream) return "";
  return stream.encoding === "base64" ? Buffer.from(stream.value, "base64").toString("utf8") : stream.value;
}

export function toRunResult(operation: OperationResponse): RunResult {
  const result = operation.metadata?.result ?? undefined;
  return {
    operationId: operation.uuid,
    status: operation.status,
    exitCode: result?.state?.exit_code ?? null,
    timedOut: result?.state?.timed_out ?? false,
    stdout: decodeStream(result?.stdout),
    stderr: decodeStream(result?.stderr),
    resultImage: operation.result_image_uuid ?? null,
    durationSeconds: operation.duration ?? null,
    cost: result?.resources?.cost ?? null,
    error: operation.error ?? null,
  };
}

export function createSandboxClient(options: SandboxClientOptions) {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;

  async function request<T>(method: string, path: string, body?: { json?: unknown; bytes?: Uint8Array | string }): Promise<T> {
    const headers = new Headers({ Authorization: `Bearer ${options.token}`, Project: options.project });
    let payload: BodyInit | undefined;
    if (body?.json !== undefined) {
      headers.set("Content-Type", "application/json");
      payload = JSON.stringify(body.json);
    } else if (body?.bytes !== undefined) {
      headers.set("Content-Type", "application/octet-stream");
      payload = typeof body.bytes === "string" ? body.bytes : new Blob([new Uint8Array(body.bytes)]);
    }

    const response = await doFetch(`${baseUrl}${path}`, { method, headers, body: payload });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (parsed.error !== undefined) message = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
      } catch {
        // keep raw text
      }
      throw new Error(`Sandbox API ${method} ${path} failed: ${response.status} ${message}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const client = {
    listImages(tagPrefix?: string) {
      const query = tagPrefix ? `?tag=${encodeURIComponent(tagPrefix)}` : "";
      return request<{ images: Array<{ uuid: string; tag?: string }> }>("GET", `/images${query}`);
    },

    async importImage(registryUrl: string, tag?: string): Promise<string> {
      const created = await request<{ uuid: string }>("POST", "/images/import", { json: { registry: { url: registryUrl }, tag } });
      return created.uuid;
    },

    uploadFile(content: Uint8Array | string) {
      return request<{ uuid: string; sha256: string; size: number }>("POST", "/files", { bytes: content });
    },

    async spawn(spawnRequest: SpawnRequest): Promise<string> {
      const created = await request<{ uuid: string }>("POST", "/instances", { json: spawnRequest });
      return created.uuid;
    },

    getOperation(operationId: string) {
      return request<OperationResponse>("GET", `/operations/${operationId}`);
    },

    async waitForOperation(operationId: string, { pollMs = 1000, timeoutMs = 15 * 60_000 } = {}): Promise<OperationResponse> {
      const deadline = now() + timeoutMs;
      for (;;) {
        const operation = await client.getOperation(operationId);
        if (TERMINAL.has(operation.status)) return operation;
        if (now() + pollMs > deadline) throw new Error(`Operation ${operationId} timed out waiting (last status ${operation.status})`);
        await sleep(pollMs);
      }
    },

    async run(spawnRequest: SpawnRequest, wait?: { pollMs?: number; timeoutMs?: number }): Promise<RunResult> {
      const operationId = await client.spawn(spawnRequest);
      return toRunResult(await client.waitForOperation(operationId, wait));
    },
  };
  return client;
}

export type SandboxClient = ReturnType<typeof createSandboxClient>;
