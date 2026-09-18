/**
 * Minimal client for Nebius Token Factory Sandboxes (ConTree API).
 * Spike quality: covers only what a Test Run needs.
 * API reference: https://docs.tokenfactory.nebius.com/api-reference/sandboxes
 */

export const DEFAULT_BASE_URL =
  "https://api.tokenfactory.nebius.com/sandboxes/v1";

export type StreamRepr = {
  value: string;
  encoding: "ascii" | "base64";
  truncated?: boolean;
};

export type InstanceResult = {
  state?: { exit_code?: number; timed_out?: boolean; signal?: number };
  stdout?: StreamRepr;
  stderr?: StreamRepr;
  resources?: { cost?: number; elapsed_time?: number };
};

export type OperationStatus =
  "PENDING" | "ASSIGNED" | "EXECUTING" | "SUCCESS" | "FAILED" | "CANCELLED";

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

export type FileRef = {
  uuid: string;
  mode?: string;
  uid?: number;
  gid?: number;
};

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

const TERMINAL: ReadonlySet<OperationStatus> = new Set([
  "SUCCESS",
  "FAILED",
  "CANCELLED",
]);

export function decodeStream(stream: StreamRepr | undefined): string {
  if (!stream) return "";
  return stream.encoding === "base64"
    ? Buffer.from(stream.value, "base64").toString("utf8")
    : stream.value;
}

/**
 * True only if the command itself succeeded. An operation's `SUCCESS` status
 * means the sandbox ran — it stays SUCCESS for non-zero exit codes and timeouts.
 */
export function commandSucceeded(result: RunResult): boolean {
  return (
    result.status === "SUCCESS" && result.exitCode === 0 && !result.timedOut
  );
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

type ImageList = { images: Array<{ uuid: string; tag?: string }> };
type UploadedFile = { uuid: string; sha256: string; size: number };
type WaitOptions = { pollMs?: number; timeoutMs?: number };
type RequestBody = { json?: unknown; bytes?: Uint8Array | string };

/** Nebius Token Factory Sandboxes, as used by Test Runs. */
export interface SandboxClient {
  listImages: (tagPrefix?: string) => Promise<ImageList>;
  importImage: (registryUrl: string, tag?: string) => Promise<string>;
  uploadFile: (content: Uint8Array | string) => Promise<UploadedFile>;
  spawn: (spawnRequest: SpawnRequest) => Promise<string>;
  getOperation: (operationId: string) => Promise<OperationResponse>;
  waitForOperation: (
    operationId: string,
    wait?: WaitOptions,
  ) => Promise<OperationResponse>;
  run: (spawnRequest: SpawnRequest, wait?: WaitOptions) => Promise<RunResult>;
}

/** SandboxClient over the Sandboxes REST API (ConTree). */
export class NebiusSandboxClient implements SandboxClient {
  #token: string;
  #project: string;
  #baseUrl: string;
  #fetch: typeof fetch;
  #sleep: (ms: number) => Promise<void>;
  #now: () => number;

  constructor(options: SandboxClientOptions) {
    this.#token = options.token;
    this.#project = options.project;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#sleep =
      options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.#now = options.now ?? Date.now;
  }

  listImages = (tagPrefix?: string): Promise<ImageList> => {
    const query = tagPrefix ? `?tag=${encodeURIComponent(tagPrefix)}` : "";
    return this.#request<ImageList>("GET", `/images${query}`);
  };

  importImage = async (registryUrl: string, tag?: string): Promise<string> => {
    const created = await this.#request<{ uuid: string }>(
      "POST",
      "/images/import",
      { json: { registry: { url: registryUrl }, tag } },
    );
    return created.uuid;
  };

  uploadFile = (content: Uint8Array | string): Promise<UploadedFile> =>
    this.#request<UploadedFile>("POST", "/files", { bytes: content });

  spawn = async (spawnRequest: SpawnRequest): Promise<string> => {
    const created = await this.#request<{ uuid: string }>(
      "POST",
      "/instances",
      { json: spawnRequest },
    );
    return created.uuid;
  };

  getOperation = (operationId: string): Promise<OperationResponse> =>
    this.#request<OperationResponse>("GET", `/operations/${operationId}`);

  waitForOperation = async (
    operationId: string,
    { pollMs = 1000, timeoutMs = 15 * 60_000 }: WaitOptions = {},
  ): Promise<OperationResponse> => {
    const deadline = this.#now() + timeoutMs;
    for (;;) {
      const operation = await this.getOperation(operationId);
      if (TERMINAL.has(operation.status)) return operation;
      if (this.#now() + pollMs > deadline)
        throw new Error(
          `Operation ${operationId} timed out waiting (last status ${operation.status})`,
        );
      await this.#sleep(pollMs);
    }
  };

  run = async (
    spawnRequest: SpawnRequest,
    wait?: WaitOptions,
  ): Promise<RunResult> => {
    const operationId = await this.spawn(spawnRequest);
    return toRunResult(await this.waitForOperation(operationId, wait));
  };

  async #request<T>(
    method: string,
    path: string,
    body?: RequestBody,
  ): Promise<T> {
    const headers = new Headers({
      Authorization: `Bearer ${this.#token}`,
      Project: this.#project,
    });
    let payload: BodyInit | undefined;
    if (body?.json !== undefined) {
      headers.set("Content-Type", "application/json");
      payload = JSON.stringify(body.json);
    } else if (body?.bytes !== undefined) {
      headers.set("Content-Type", "application/octet-stream");
      payload =
        typeof body.bytes === "string"
          ? body.bytes
          : new Blob([new Uint8Array(body.bytes)]);
    }

    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      body: payload,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Sandbox API ${method} ${path} failed: ${response.status} ${errorMessage(text)}`,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

function errorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed.error !== undefined)
      return typeof parsed.error === "string"
        ? parsed.error
        : JSON.stringify(parsed.error);
  } catch {
    // not JSON: fall through to the raw text
  }
  return text;
}
