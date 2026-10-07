// SPDX-License-Identifier: MPL-2.0
/**
 * The Sandbox as an MCP server (S6): any MCP client (Claude Code, an IDE, another
 * agent) can run a command in an isolated Nebius sandbox, and nothing more.
 *
 * It speaks over stdio, so the client that starts it is the only one that can
 * talk to it; there is no network listener. The Nebius key is read by the
 * process that starts it and never appears in a tool's input or output. What a
 * client may spend or send is bounded here, whatever it asks for: a run count,
 * a time limit, the size of what it uploads and of what it reads back.
 *
 * Every run is disposable: it leaves no image, so a client cannot build state
 * in the sandbox that a later call depends on.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { redactSecrets } from "../redactSecrets.js";
import type { SandboxClient } from "./sandboxClient.js";

export type SandboxMcpLimits = {
  /** Commands one server process runs before it refuses more. */
  maxRuns: number;
  /** Images one server process imports before it refuses more. */
  maxImports: number;
  maxTimeoutSeconds: number;
  maxFiles: number;
  /** Bytes of one uploaded file, and of all of them together. */
  maxFileBytes: number;
  maxTotalFileBytes: number;
  /** Characters of each of stdout and stderr given back. */
  maxOutputChars: number;
  maxCommandChars: number;
  maxImages: number;
};

export const DEFAULT_SANDBOX_MCP_LIMITS: SandboxMcpLimits = {
  maxRuns: 50,
  maxImports: 5,
  maxTimeoutSeconds: 600,
  maxFiles: 50,
  maxFileBytes: 200_000,
  maxTotalFileBytes: 1_000_000,
  maxOutputChars: 20_000,
  maxCommandChars: 20_000,
  maxImages: 100,
};

export type SandboxMcpServerOptions = {
  sandbox: SandboxClient;
  limits?: Partial<SandboxMcpLimits>;
  /** Taken out of everything a tool says, errors included (the Nebius key). */
  secrets?: string[];
  version?: string;
};

/** "tag:sdlc-code/node:22", or an image's uuid. */
const IMAGE = /^(tag:[A-Za-z0-9._/:-]{1,200}|[0-9a-fA-F-]{32,40})$/;
/** An absolute path inside the sandbox; uploaded files are also checked for "..". */
const FILE_PATH = /^\/[^\0]*$/;

type Reply = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * A composition function, not a client: the counters, limits and secrets live
 * in its closure, which holds them as `#private` does, and the SandboxClient it
 * wraps is the interface (SC-1) everything is done through.
 */
export function createSandboxMcpServer(
  options: SandboxMcpServerOptions,
): McpServer {
  const { sandbox } = options;
  const limits = { ...DEFAULT_SANDBOX_MCP_LIMITS, ...options.limits };
  const secrets = options.secrets ?? [];
  let runs = 0;
  let imports = 0;

  const say = (text: string): Reply => ({
    content: [{ type: "text", text: redactSecrets(text, secrets) }],
  });
  const fail = (text: string): Reply => ({ ...say(text), isError: true });
  const failed = (error: unknown): Reply =>
    fail(cut(error instanceof Error ? error.message : String(error), 2000));
  const cut = (text: string, max: number): string =>
    text.length <= max
      ? text
      : `${text.slice(0, max)}\n…(cut: ${text.length - max} more characters)`;

  const server = new McpServer({
    name: "sdlc-code-sandbox",
    version: options.version ?? "0.1.0",
  });

  server.registerTool(
    "sandbox_whoami",
    {
      title: "Sandbox access",
      description:
        "Which Sandbox permissions and limits the configured Nebius key has.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return say(JSON.stringify(await sandbox.whoAmI(), null, 2));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    "sandbox_list_images",
    {
      title: "List sandbox images",
      description: `The images a command can start from, as "tag uuid" lines (at most ${limits.maxImages}). Start a run from one with image "tag:<tag>".`,
      inputSchema: {
        tagPrefix: z
          .string()
          .max(200)
          .optional()
          .describe("Only images whose tag starts with this"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ tagPrefix }) => {
      try {
        const { images } = await sandbox.listImages(tagPrefix);
        const lines = images
          .slice(0, limits.maxImages)
          .map((image) => `${image.tag ?? "(no tag)"} ${image.uuid}`);
        const more =
          images.length > limits.maxImages
            ? `\n…and ${images.length - limits.maxImages} more: narrow it with tagPrefix.`
            : "";
        return say(
          images.length === 0 ? "No images." : `${lines.join("\n")}${more}`,
        );
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    "sandbox_import_image",
    {
      title: "Import a container image",
      description: `Imports a public container image once, so runs can start from its tag. Costs sandbox credit and time; at most ${limits.maxImports} per server session. Example: registryUrl "docker://docker.io/library/node:22", tag "node:22".`,
      inputSchema: {
        registryUrl: z
          .string()
          .regex(/^docker:\/\/[A-Za-z0-9._/:@-]{1,300}$/)
          .describe('A "docker://" URL'),
        tag: z
          .string()
          .regex(/^[A-Za-z0-9._/:-]{1,200}$/)
          .optional()
          .describe("The name to start runs from, as image tag:<this>"),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ registryUrl, tag }) => {
      if (imports >= limits.maxImports)
        return fail(
          `This server has imported ${limits.maxImports} images, the most it allows in one session. Start it again to import more.`,
        );
      imports += 1;
      try {
        const id = await sandbox.importImage(registryUrl, tag);
        return say(
          `Importing ${registryUrl}${tag ? ` as tag:${tag}` : ""} (operation ${id}). It is ready when sandbox_list_images shows it; start runs from its tag, not from this operation id.`,
        );
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    "sandbox_run",
    {
      title: "Run a command in a sandbox",
      description: `Runs a shell command in a fresh, isolated sandbox started from an image, and gives back its exit code and output. The sandbox is thrown away afterwards: nothing it writes is kept. Costs sandbox credit; at most ${limits.maxRuns} runs per server session, ${limits.maxTimeoutSeconds} s each.`,
      inputSchema: {
        image: z
          .string()
          .regex(IMAGE)
          .describe('"tag:<name>" (see sandbox_list_images) or an image uuid'),
        command: z
          .string()
          .min(1)
          .max(limits.maxCommandChars)
          .describe("A shell command, run with sh -c"),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            `Text files to put in the sandbox first: absolute path to contents (at most ${limits.maxFiles} files, ${limits.maxFileBytes} bytes each)`,
          ),
        cwd: z
          .string()
          .regex(FILE_PATH)
          .optional()
          .describe("The working directory, absolute"),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(limits.maxTimeoutSeconds)
          .optional()
          .describe(
            `Seconds before the command is stopped; default 120, at most ${limits.maxTimeoutSeconds}`,
          ),
        networking: z
          .boolean()
          .optional()
          .describe(
            "Whether the command may reach the network; the sandbox's own default when left out",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ image, command, files, cwd, timeoutSeconds, networking }) => {
      if (runs >= limits.maxRuns)
        return fail(
          `This server has run ${limits.maxRuns} commands, the most it allows in one session. Start it again to run more.`,
        );
      const problem = fileProblem(files ?? {}, limits);
      if (problem) return fail(problem);
      runs += 1;
      try {
        const uploaded: Record<string, { uuid: string }> = {};
        for (const [path, contents] of Object.entries(files ?? {}))
          uploaded[path] = { uuid: (await sandbox.uploadFile(contents)).uuid };
        const timeout = timeoutSeconds ?? 120;
        const result = await sandbox.run(
          {
            image,
            command,
            shell: true,
            cwd,
            timeout,
            // The sandbox cuts its output too, so a huge one is never held whole here.
            truncate_output_at: limits.maxOutputChars,
            // Nothing a client does leaves state behind.
            disposable: true,
            ...(networking === undefined
              ? {}
              : { networking: { enabled: networking } }),
            ...(Object.keys(uploaded).length > 0 ? { files: uploaded } : {}),
          },
          // The sandbox stops the command at `timeout`; this only bounds the wait.
          { timeoutMs: (timeout + 120) * 1000 },
        );
        const lines = [
          `exit code: ${result.exitCode ?? "none"}${result.timedOut ? " (timed out)" : ""}`,
          `status: ${result.status}${result.error ? `: ${cut(result.error, 1000)}` : ""}`,
          `duration: ${result.durationSeconds ?? "?"} s, cost: ${result.cost ?? "?"}`,
          `--- stdout ---\n${cut(result.stdout, limits.maxOutputChars)}`,
          `--- stderr ---\n${cut(result.stderr, limits.maxOutputChars)}`,
        ];
        const reply = say(lines.join("\n"));
        // A command that exited non-zero is an answer (the sandbox still says
        // SUCCESS); a sandbox that did not run is not.
        return result.status === "SUCCESS"
          ? reply
          : { ...reply, isError: true };
      } catch (error) {
        return failed(error);
      }
    },
  );

  return server;
}

/** Why the files cannot be uploaded, or null when they can. */
function fileProblem(
  files: Record<string, string>,
  limits: SandboxMcpLimits,
): string | null {
  const entries = Object.entries(files);
  if (entries.length > limits.maxFiles)
    return `At most ${limits.maxFiles} files may be uploaded; ${entries.length} were given.`;
  let total = 0;
  for (const [path, contents] of entries) {
    if (!FILE_PATH.test(path) || path.split("/").includes(".."))
      return `"${path}" is not an absolute path inside the sandbox (no "..").`;
    // Bytes, not characters: one CJK character is three, and the sandbox is told bytes.
    const bytes = Buffer.byteLength(contents);
    if (bytes > limits.maxFileBytes)
      return `"${path}" is ${bytes} bytes; at most ${limits.maxFileBytes} per file.`;
    total += bytes;
  }
  if (total > limits.maxTotalFileBytes)
    return `The files are ${total} bytes together; at most ${limits.maxTotalFileBytes}.`;
  return null;
}
