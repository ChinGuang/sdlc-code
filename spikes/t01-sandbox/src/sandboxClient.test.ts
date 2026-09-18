import { describe, expect, it, vi } from "vitest";
import { createSandboxClient, decodeStream, type OperationResponse } from "./sandboxClient.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
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

const base = { baseUrl: "https://sandbox.test/v1", token: "tkn", project: "proj-1" };

function op(overrides: Partial<OperationResponse>): OperationResponse {
  return { uuid: "op-1", kind: "instance", status: "EXECUTING", ...overrides };
}

describe("decodeStream", () => {
  it("returns ascii values unchanged", () => {
    expect(decodeStream({ value: "hello\n", encoding: "ascii" })).toBe("hello\n");
  });

  it("decodes base64 values", () => {
    expect(decodeStream({ value: Buffer.from("héllo").toString("base64"), encoding: "base64" })).toBe("héllo");
  });

  it("treats a missing stream as empty", () => {
    expect(decodeStream(undefined)).toBe("");
  });
});

describe("createSandboxClient", () => {
  it("sends bearer token and Project header on every request", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { images: [] } }]);
    await createSandboxClient({ ...base, fetch }).listImages();

    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer tkn");
    expect(headers.get("project")).toBe("proj-1");
  });

  it("uploads raw bytes as octet-stream and returns the file uuid", async () => {
    const { fetch, calls } = fakeFetch([{ status: 201, body: { uuid: "file-1", sha256: "abc", size: 5 } }]);
    const file = await createSandboxClient({ ...base, fetch }).uploadFile("hello");

    expect(calls[0]!.url).toBe("https://sandbox.test/v1/files");
    expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe("application/octet-stream");
    expect(file.uuid).toBe("file-1");
  });

  it("spawns an instance and returns the operation id", async () => {
    const { fetch, calls } = fakeFetch([{ status: 201, body: { uuid: "op-9" } }]);
    const id = await createSandboxClient({ ...base, fetch }).spawn({ image: "tag:node:22", command: "node -v", shell: true });

    expect(calls[0]!.url).toBe("https://sandbox.test/v1/instances");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ image: "tag:node:22", command: "node -v", shell: true });
    expect(id).toBe("op-9");
  });

  it("throws with status and API error message on failure", async () => {
    const { fetch } = fakeFetch([{ status: 401, body: { error: "missing Project header" } }]);
    await expect(createSandboxClient({ ...base, fetch }).listImages()).rejects.toThrow(/401.*missing Project header/);
  });

  it("polls an operation until it reaches a terminal status", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: op({ status: "PENDING" }) },
      { status: 200, body: op({ status: "EXECUTING" }) },
      { status: 200, body: op({ status: "SUCCESS", result_image_uuid: "img-2" }) },
    ]);
    const sleep = vi.fn(async () => {});
    const done = await createSandboxClient({ ...base, fetch, sleep }).waitForOperation("op-1", { pollMs: 10 });

    expect(done.status).toBe("SUCCESS");
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up waiting after the timeout", async () => {
    const { fetch } = fakeFetch(Array.from({ length: 5 }, () => ({ status: 200, body: op({ status: "EXECUTING" }) })));
    let now = 0;
    const client = createSandboxClient({ ...base, fetch, sleep: async (ms) => void (now += ms), now: () => now });

    await expect(client.waitForOperation("op-1", { pollMs: 1000, timeoutMs: 2500 })).rejects.toThrow(/timed out/);
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
              stdout: { value: Buffer.from("out").toString("base64"), encoding: "base64" },
              stderr: { value: "err", encoding: "ascii" },
              resources: { cost: 0.002, elapsed_time: 1.4 },
            },
          },
        }),
      },
    ]);
    const result = await createSandboxClient({ ...base, fetch, sleep: async () => {} }).run({ image: "img-1", command: "exit 3", shell: true });

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
