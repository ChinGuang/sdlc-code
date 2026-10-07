// SPDX-License-Identifier: MPL-2.0
/**
 * The Sandbox MCP server (S6), driven by a real MCP client over the SDK's
 * in-memory transport and a fake sandbox that records what it is asked to do.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type {
  RunResult,
  SandboxClient,
  SpawnRequest,
} from "./sandboxClient.js";
import {
  createSandboxMcpServer,
  DEFAULT_SANDBOX_MCP_LIMITS,
  type SandboxMcpLimits,
} from "./sandboxMcpServer.js";

const SECRET = "nebius-key-1234567890";

const ran = (overrides: Partial<RunResult> = {}): RunResult => ({
  operationId: "op-1",
  status: "SUCCESS",
  exitCode: 0,
  timedOut: false,
  stdout: "hello\n",
  stderr: "",
  resultImage: null,
  durationSeconds: 1.5,
  cost: 0.002,
  error: null,
  ...overrides,
});

type Fake = {
  spawned: SpawnRequest[];
  uploaded: string[];
  imports: Array<{ url: string; tag?: string }>;
  result: RunResult;
  images: Array<{ uuid: string; tag?: string }>;
  failWith?: Error;
};

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(
  options: { limits?: Partial<SandboxMcpLimits>; fake?: Partial<Fake> } = {},
) {
  const fake: Fake = {
    spawned: [],
    uploaded: [],
    imports: [],
    result: ran(),
    images: [{ uuid: "img-1", tag: "sdlc-code/node:22" }],
    ...options.fake,
  };
  // Tests depend on the interface; this is the whole fake.
  const sandbox: SandboxClient = {
    listImages: async (prefix) => ({
      images: fake.images.filter((image) =>
        prefix ? image.tag?.startsWith(prefix) : true,
      ),
    }),
    importImage: async (url, tag) => {
      if (fake.failWith) throw fake.failWith;
      fake.imports.push({ url, tag });
      return "import-op";
    },
    uploadFile: async (content) => {
      fake.uploaded.push(String(content));
      return { uuid: `file-${fake.uploaded.length}`, sha256: "x", size: 1 };
    },
    spawn: async () => "op",
    getOperation: async () => {
      throw new Error("not used");
    },
    waitForOperation: async () => {
      throw new Error("not used");
    },
    run: async (request) => {
      if (fake.failWith) throw fake.failWith;
      fake.spawned.push(request);
      return fake.result;
    },
    whoAmI: async () => ({
      permissions: { run: true },
      limits: { instances: 4 },
    }),
  };
  const server = createSandboxMcpServer({
    sandbox,
    limits: options.limits,
    secrets: [SECRET],
  });
  const client = new Client({ name: "test", version: "0" });
  clients.push(client);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, fake };
}

type ToolReply = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

/** A tool call's result, whether the server answered it or refused its input. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  try {
    const reply = (await client.callTool({
      name,
      arguments: args,
    })) as ToolReply;
    return {
      text: reply.content.map((part) => part.text).join("\n"),
      isError: reply.isError === true,
    };
  } catch (error) {
    // The SDK may refuse a call that does not match the tool's schema.
    return {
      text: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

describe("the Sandbox MCP server's tools", () => {
  it("offers four tools, and marks the reading ones as read only", async () => {
    const { client } = await connect();

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "sandbox_import_image",
      "sandbox_list_images",
      "sandbox_run",
      "sandbox_whoami",
    ]);
    const by = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(by.sandbox_whoami!.annotations?.readOnlyHint).toBe(true);
    expect(by.sandbox_list_images!.annotations?.readOnlyHint).toBe(true);
    expect(by.sandbox_run!.annotations?.readOnlyHint).toBe(false);
    expect(by.sandbox_run!.inputSchema.required).toEqual(["image", "command"]);
  });

  it("says what access the key has", async () => {
    const { client } = await connect();

    const reply = await call(client, "sandbox_whoami");

    expect(JSON.parse(reply.text)).toEqual({
      permissions: { run: true },
      limits: { instances: 4 },
    });
  });

  it("lists images as tag and id, narrowed by a prefix, and says when there are none", async () => {
    const { client } = await connect({
      fake: {
        images: [
          { uuid: "a", tag: "sdlc-code/node:22" },
          { uuid: "b", tag: "other" },
          { uuid: "c" },
        ],
      },
    });

    expect((await call(client, "sandbox_list_images")).text).toBe(
      "sdlc-code/node:22 a\nother b\n(no tag) c",
    );
    expect(
      (await call(client, "sandbox_list_images", { tagPrefix: "sdlc" })).text,
    ).toBe("sdlc-code/node:22 a");
    expect(
      (await call(client, "sandbox_list_images", { tagPrefix: "zzz" })).text,
    ).toBe("No images.");
  });

  it("cuts a long image list, and says to narrow it", async () => {
    const { client } = await connect({
      limits: { maxImages: 2 },
      fake: {
        images: Array.from({ length: 5 }, (_, index) => ({
          uuid: `u${index}`,
          tag: `t${index}`,
        })),
      },
    });

    const reply = await call(client, "sandbox_list_images");

    expect(reply.text).toContain("t1 u1");
    expect(reply.text).not.toContain("t2 u2");
    expect(reply.text).toContain("and 3 more: narrow it with tagPrefix");
  });
});

describe("sandbox_run", () => {
  it("runs a command in a disposable sandbox and gives back its answer", async () => {
    const { client, fake } = await connect();

    const reply = await call(client, "sandbox_run", {
      image: "tag:sdlc-code/node:22",
      command: "echo hello",
    });

    expect(reply.isError).toBe(false);
    expect(reply.text).toContain("exit code: 0");
    expect(reply.text).toContain("--- stdout ---\nhello");
    expect(reply.text).toContain("cost: 0.002");
    expect(fake.spawned).toEqual([
      {
        image: "tag:sdlc-code/node:22",
        command: "echo hello",
        shell: true,
        timeout: 120,
        truncate_output_at: DEFAULT_SANDBOX_MCP_LIMITS.maxOutputChars,
        // Nothing a client does may leave state behind.
        disposable: true,
      },
    ]);
  });

  it("uploads files first and puts each where the client said", async () => {
    const { client, fake } = await connect();

    await call(client, "sandbox_run", {
      image: "tag:x",
      command: "node /app/a.js",
      files: { "/app/a.js": "console.log(1)", "/app/b.json": "{}" },
      cwd: "/app",
      networking: false,
      timeoutSeconds: 30,
    });

    expect(fake.uploaded).toEqual(["console.log(1)", "{}"]);
    expect(fake.spawned[0]).toMatchObject({
      files: {
        "/app/a.js": { uuid: "file-1" },
        "/app/b.json": { uuid: "file-2" },
      },
      cwd: "/app",
      networking: { enabled: false },
      timeout: 30,
      disposable: true,
    });
  });

  it("takes a command that failed for an answer, not an error", async () => {
    const { client } = await connect({
      fake: { result: ran({ exitCode: 3, stderr: "boom\n" }) },
    });

    const reply = await call(client, "sandbox_run", {
      image: "tag:x",
      command: "false",
    });

    expect(reply.isError).toBe(false);
    expect(reply.text).toContain("exit code: 3");
    expect(reply.text).toContain("--- stderr ---\nboom");
  });

  it("says a command that timed out did, and a sandbox that did not run is an error", async () => {
    const timedOut = await connect({
      fake: { result: ran({ exitCode: null, timedOut: true }) },
    });
    const broken = await connect({
      fake: {
        result: ran({ status: "FAILED", exitCode: null, error: "no capacity" }),
      },
    });

    const slow = await call(timedOut.client, "sandbox_run", {
      image: "tag:x",
      command: "sleep 999",
    });
    const down = await call(broken.client, "sandbox_run", {
      image: "tag:x",
      command: "true",
    });

    expect(slow.text).toContain("(timed out)");
    expect(slow.isError).toBe(false);
    expect(down.isError).toBe(true);
    expect(down.text).toContain("FAILED: no capacity");
  });

  it("cuts a long output, and says how much", async () => {
    const { client } = await connect({
      limits: { maxOutputChars: 10 },
      fake: { result: ran({ stdout: "x".repeat(25) }) },
    });

    const reply = await call(client, "sandbox_run", {
      image: "tag:x",
      command: "yes",
    });

    expect(reply.text).toContain(
      `${"x".repeat(10)}\n…(cut: 15 more characters)`,
    );
  });

  it("takes the Nebius key out of whatever it says, errors included", async () => {
    const echoing = await connect({
      fake: { result: ran({ stdout: `key is ${SECRET}` }) },
    });
    const failing = await connect({
      fake: { failWith: new Error(`401 for key ${SECRET}`) },
    });

    const out = await call(echoing.client, "sandbox_run", {
      image: "tag:x",
      command: "env",
    });
    const err = await call(failing.client, "sandbox_run", {
      image: "tag:x",
      command: "env",
    });

    expect(out.text).not.toContain(SECRET);
    expect(out.text).toContain("key is [redacted]");
    expect(err.isError).toBe(true);
    expect(err.text).not.toContain(SECRET);
  });

  it.each([
    [
      "an image that is neither a tag nor an id",
      { image: "docker.io/evil:latest", command: "x" },
    ],
    ["an empty command", { image: "tag:x", command: "" }],
    [
      "a timeout past the limit",
      { image: "tag:x", command: "x", timeoutSeconds: 601 },
    ],
    ["a timeout of zero", { image: "tag:x", command: "x", timeoutSeconds: 0 }],
    [
      "a relative working directory",
      { image: "tag:x", command: "x", cwd: "app" },
    ],
  ])("refuses %s, and starts nothing", async (_name, args) => {
    const { client, fake } = await connect();

    const reply = await call(client, "sandbox_run", args);

    expect(reply.isError).toBe(true);
    expect(fake.spawned).toEqual([]);
  });

  it.each([
    ["a relative path", { "app/a.js": "x" }, /not an absolute path/],
    [
      "a path that walks out",
      { "/app/../etc/passwd": "x" },
      /not an absolute path/,
    ],
    ["too many files", { "/a": "x", "/b": "x", "/c": "x" }, /At most 2 files/],
    [
      "a file that is too long",
      { "/a": "x".repeat(11) },
      /at most 10 per file/,
    ],
    // Three bytes each: four characters, twelve bytes.
    [
      "a file that is short in characters but long in bytes",
      { "/a": "界界界界" },
      /is 12 bytes; at most 10 per file/,
    ],
    [
      "files too long together",
      { "/a": "x".repeat(8), "/b": "x".repeat(8) },
      /at most 12/,
    ],
  ])(
    "refuses %s, uploading and starting nothing",
    async (_name, files, why) => {
      const { client, fake } = await connect({
        limits: { maxFiles: 2, maxFileBytes: 10, maxTotalFileBytes: 12 },
      });

      const reply = await call(client, "sandbox_run", {
        image: "tag:x",
        command: "x",
        files,
      });

      expect(reply.isError).toBe(true);
      expect(reply.text).toMatch(why);
      expect(fake.uploaded).toEqual([]);
      expect(fake.spawned).toEqual([]);
    },
  );

  it("stops after the runs it allows in a session, and says so", async () => {
    const { client, fake } = await connect({ limits: { maxRuns: 2 } });
    const run = () =>
      call(client, "sandbox_run", { image: "tag:x", command: "true" });

    const first = await run();
    const second = await run();
    const third = await run();

    expect([first.isError, second.isError, third.isError]).toEqual([
      false,
      false,
      true,
    ]);
    expect(third.text).toContain("run 2 commands, the most it allows");
    expect(fake.spawned).toHaveLength(2);
  });

  it("does not let a refused call use up a run", async () => {
    const { client, fake } = await connect({ limits: { maxRuns: 1 } });

    await call(client, "sandbox_run", {
      image: "tag:x",
      command: "x",
      files: { relative: "x" },
    });
    const reply = await call(client, "sandbox_run", {
      image: "tag:x",
      command: "true",
    });

    expect(reply.isError).toBe(false);
    expect(fake.spawned).toHaveLength(1);
  });
});

describe("what the server says of a failure", () => {
  it("cuts a long error, so a gateway's page is not handed to the model whole", async () => {
    const { client } = await connect({
      fake: { failWith: new Error("x".repeat(5000)) },
    });

    const reply = await call(client, "sandbox_run", {
      image: "tag:x",
      command: "true",
    });

    expect(reply.isError).toBe(true);
    expect(reply.text.length).toBeLessThan(2200);
    expect(reply.text).toContain("…(cut: 3000 more characters)");
  });
});

describe("sandbox_import_image", () => {
  it("imports a docker:// image, and refuses any other source", async () => {
    const { client, fake } = await connect();

    const ok = await call(client, "sandbox_import_image", {
      registryUrl: "docker://docker.io/library/node:22",
      tag: "node:22",
    });
    const bad = await call(client, "sandbox_import_image", {
      registryUrl: "https://evil.example/image",
    });

    expect(ok.isError).toBe(false);
    expect(ok.text).toContain("as tag:node:22");
    // The id the import returns is an operation, not an image to start from.
    expect(ok.text).toContain("not from this operation id");
    expect(bad.isError).toBe(true);
    expect(fake.imports).toEqual([
      { url: "docker://docker.io/library/node:22", tag: "node:22" },
    ]);
  });

  it("stops after the imports it allows in a session", async () => {
    const { client, fake } = await connect({ limits: { maxImports: 1 } });
    const url = "docker://docker.io/library/node:22";

    const first = await call(client, "sandbox_import_image", {
      registryUrl: url,
    });
    const second = await call(client, "sandbox_import_image", {
      registryUrl: url,
    });

    expect(first.isError).toBe(false);
    expect(second.isError).toBe(true);
    expect(fake.imports).toHaveLength(1);
  });
});

describe("DEFAULT_SANDBOX_MCP_LIMITS", () => {
  it("are finite and small enough to bound what a client can spend", () => {
    for (const value of Object.values(DEFAULT_SANDBOX_MCP_LIMITS))
      expect(Number.isFinite(value) && value > 0).toBe(true);
    expect(DEFAULT_SANDBOX_MCP_LIMITS.maxRuns).toBeLessThanOrEqual(100);
    expect(DEFAULT_SANDBOX_MCP_LIMITS.maxTimeoutSeconds).toBeLessThanOrEqual(
      900,
    );
  });
});
