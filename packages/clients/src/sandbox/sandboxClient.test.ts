import { describe, expect, it, vi } from "vitest";
import {
  commandSucceeded,
  decodeStream,
  NebiusSandboxClient,
  type OperationResponse,
  type RunResult,
  type SandboxClient,
  type SandboxClientOptions,
} from "./sandboxClient.js";

// Tests depend on the interface; only this factory knows the class.
const makeClient = (options: SandboxClientOptions): SandboxClient =>
  new NebiusSandboxClient(options);

type Call = { url: string; init: RequestInit };

function fakeFetch(
  responses: Array<{
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  }>,
) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${String(url)}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...next.headers },
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const base = {
  baseUrl: "https://sandbox.test/v1",
  token: "tkn",
  project: "proj-1",
};

function op(overrides: Partial<OperationResponse>): OperationResponse {
  return { uuid: "op-1", kind: "instance", status: "EXECUTING", ...overrides };
}

describe("decodeStream", () => {
  it("returns ascii values unchanged", () => {
    expect(decodeStream({ value: "hello\n", encoding: "ascii" })).toBe(
      "hello\n",
    );
  });

  it("decodes base64 values", () => {
    expect(
      decodeStream({
        value: Buffer.from("héllo").toString("base64"),
        encoding: "base64",
      }),
    ).toBe("héllo");
  });

  it("treats a missing stream as empty", () => {
    expect(decodeStream(undefined)).toBe("");
  });
});

describe("SandboxClient", () => {
  it("sends bearer token and Project header on every request", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { images: [] } }]);
    await makeClient({ ...base, fetch }).listImages();

    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer tkn");
    expect(headers.get("project")).toBe("proj-1");
  });

  it("uploads raw bytes as octet-stream and returns the file uuid", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 201, body: { uuid: "file-1", sha256: "abc", size: 5 } },
    ]);
    const file = await makeClient({ ...base, fetch }).uploadFile("hello");

    expect(calls[0]!.url).toBe("https://sandbox.test/v1/files");
    expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(file.uuid).toBe("file-1");
  });

  it("spawns an instance and returns the operation id", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 201, body: { uuid: "op-9" } },
    ]);
    const id = await makeClient({ ...base, fetch }).spawn({
      image: "tag:node:22",
      command: "node -v",
      shell: true,
    });

    expect(calls[0]!.url).toBe("https://sandbox.test/v1/instances");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      image: "tag:node:22",
      command: "node -v",
      shell: true,
    });
    expect(id).toBe("op-9");
  });

  it("throws with status and API error message on failure", async () => {
    const { fetch } = fakeFetch([
      { status: 401, body: { error: "missing Project header" } },
    ]);
    await expect(makeClient({ ...base, fetch }).listImages()).rejects.toThrow(
      /401.*missing Project header/,
    );
  });

  it("polls an operation until it reaches a terminal status", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: op({ status: "PENDING" }) },
      { status: 200, body: op({ status: "EXECUTING" }) },
      {
        status: 200,
        body: op({ status: "SUCCESS", result_image_uuid: "img-2" }),
      },
    ]);
    const sleep = vi.fn(async () => {});
    const done = await makeClient({ ...base, fetch, sleep }).waitForOperation(
      "op-1",
      { pollMs: 10 },
    );

    expect(done.status).toBe("SUCCESS");
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up waiting after the timeout", async () => {
    const { fetch } = fakeFetch(
      Array.from({ length: 5 }, () => ({
        status: 200,
        body: op({ status: "EXECUTING" }),
      })),
    );
    let now = 0;
    const client = makeClient({
      ...base,
      fetch,
      sleep: async (ms) => void (now += ms),
      now: () => now,
    });

    await expect(
      client.waitForOperation("op-1", { pollMs: 1000, timeoutMs: 2500 }),
    ).rejects.toThrow(/timed out/);
  });

  it("run() spawns, waits and maps the instance result", async () => {
    const { fetch } = fakeFetch([
      { status: 201, body: { uuid: "op-1" } },
      {
        status: 200,
        body: op({
          status: "SUCCESS",
          duration: 1.5,
          result_image_uuid: "img-2",
          metadata: {
            result: {
              state: { exit_code: 3, timed_out: false },
              stdout: {
                value: Buffer.from("out").toString("base64"),
                encoding: "base64",
              },
              stderr: { value: "err", encoding: "ascii" },
              resources: { cost: 0.002, elapsed_time: 1.4 },
            },
          },
        }),
      },
    ]);
    const result = await makeClient({
      ...base,
      fetch,
      sleep: async () => {},
    }).run({ image: "img-1", command: "exit 3", shell: true });

    expect(result).toEqual({
      operationId: "op-1",
      status: "SUCCESS",
      exitCode: 3,
      timedOut: false,
      stdout: "out",
      stderr: "err",
      resultImage: "img-2",
      durationSeconds: 1.5,
      cost: 0.002,
      error: null,
    });
  });
});

describe("NebiusSandboxClient", () => {
  it("public methods work when passed as callbacks", async () => {
    const { fetch } = fakeFetch([
      { status: 201, body: { uuid: "op-1" } },
      { status: 200, body: op({ status: "SUCCESS" }) },
    ]);
    const { run } = makeClient({ ...base, fetch, sleep: async () => {} });

    await expect(
      run({ image: "img", command: "true", shell: true }),
    ).resolves.toMatchObject({ status: "SUCCESS" });
  });

  it("whoAmI returns the key's Sandbox permissions and limits", async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 200,
        body: {
          token_uuid: "t-1",
          permissions: { spawn: true, import: false },
          limits: { instance_max_timeout: 3600 },
          operations_stat: { running_instances: 0 },
        },
      },
    ]);

    const who = await makeClient({ ...base, fetch }).whoAmI();

    expect(calls[0]!.url).toBe("https://sandbox.test/v1/whoami");
    expect(who).toEqual({
      permissions: { spawn: true, import: false },
      limits: { instance_max_timeout: 3600 },
    });
  });

  it("never exposes the API key or project", () => {
    const client = makeClient({ ...base, token: "secret-key-123" });

    expect(Object.keys(client).sort()).toEqual([
      "getOperation",
      "importImage",
      "listImages",
      "run",
      "spawn",
      "uploadFile",
      "waitForOperation",
      "whoAmI",
    ]);
    expect("token" in client).toBe(false);
    expect("project" in client).toBe(false);
    expect(JSON.stringify(client)).not.toContain("secret-key-123");
    expect(JSON.stringify(client)).not.toContain("proj-1");
  });

  it("encodes the operation id in the URL", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: op({ status: "SUCCESS" }) },
    ]);
    await makeClient({ ...base, fetch }).getOperation("a/b?c");

    expect(calls[0]!.url).toBe("https://sandbox.test/v1/operations/a%2Fb%3Fc");
  });
});

describe("commandSucceeded", () => {
  const result = (overrides: Partial<RunResult>): RunResult => ({
    operationId: "op",
    status: "SUCCESS",
    exitCode: 0,
    timedOut: false,
    stdout: "",
    stderr: "",
    resultImage: null,
    durationSeconds: 1,
    cost: 0,
    error: null,
    ...overrides,
  });

  it("is true only for SUCCESS with exit code 0 and no timeout", () => {
    expect(commandSucceeded(result({}))).toBe(true);
  });

  // Observed live: the operation is SUCCESS even when the command failed.
  it("is false when the command exits non-zero despite operation SUCCESS", () => {
    expect(commandSucceeded(result({ exitCode: 127 }))).toBe(false);
  });

  it("is false when the command timed out despite operation SUCCESS", () => {
    expect(commandSucceeded(result({ exitCode: -1, timedOut: true }))).toBe(
      false,
    );
  });

  it("is false when the operation itself failed or has no exit code", () => {
    expect(commandSucceeded(result({ status: "FAILED" }))).toBe(false);
    expect(commandSucceeded(result({ exitCode: null }))).toBe(false);
  });
});
