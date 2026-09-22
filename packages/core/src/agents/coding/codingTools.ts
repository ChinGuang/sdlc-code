/**
 * The tools a Coding Agent calls: files in its Workspace, and, for a model
 * with the `penpotMcp` capability, a read-only look at the live design.
 */
import { z } from "zod";
import { defineTool, type AgentTool } from "../../agentLoop/tools.js";
import type { ScreenDescription, UiCanvas } from "../uiDesign/uiCanvas.js";
import { MAX_LISTED_FILES, type WorkspaceFiles } from "./workspaceFiles.js";

/** Longest read in one call; the model asks for the next lines if it needs them. */
const MAX_READ_LINES = 400;
/**
 * Spike T03 rule 2: Nemotron Super makes one tool call per turn, so reading
 * a module and its test together saves a turn per file.
 */
const MAX_BATCH_FILES = 10;

export const FILE_TOOL_NAMES = [
  "list_files",
  "read_file",
  "read_files",
  "search_files",
  "write_file",
  "edit_file",
  "delete_file",
] as const;

export const INSPECT_SCREEN = "inspect_screen";

export function fileTools(files: WorkspaceFiles): AgentTool[] {
  return [
    defineTool({
      name: "list_files",
      description:
        'List the application\'s files, optionally under one folder (e.g. "server/").',
      input: z.object({
        directory: z
          .string()
          .optional()
          .describe('Folder to list, e.g. "src/"; omit for all files'),
      }),
      run: ({ directory }) => {
        const listed = files.listFiles(directory?.replace(/\/+$/, "") ?? "");
        if (listed.length === 0) return "(no files)";
        return listed.length >= MAX_LISTED_FILES
          ? `${listed.join("\n")}\n…(only the first ${MAX_LISTED_FILES} files; list one folder at a time)`
          : listed.join("\n");
      },
    }),
    defineTool({
      name: "read_file",
      description: `Read a file. Long files come ${MAX_READ_LINES} lines at a time; pass start_line for the rest.`,
      input: z.object({
        path: z.string().describe('e.g. "server/app.ts"'),
        start_line: z.number().int().min(1).optional(),
      }),
      run: ({ path, start_line = 1 }) => {
        const lines = files.readFile(path).split("\n");
        const end = Math.min(lines.length, start_line + MAX_READ_LINES - 1);
        const body = lines.slice(start_line - 1, end).join("\n");
        return end < lines.length
          ? `${body}\n…(lines ${start_line}-${end} of ${lines.length}; read on with start_line ${end + 1})`
          : body;
      },
    }),
    defineTool({
      name: "read_files",
      description: `Read up to ${MAX_BATCH_FILES} whole files in one call, e.g. a module and its test.`,
      input: z.object({
        paths: z.array(z.string()).min(1).max(MAX_BATCH_FILES),
      }),
      run: ({ paths }) =>
        paths
          .map((path) => {
            try {
              return `=== ${path} ===\n${files.readFile(path)}`;
            } catch (error) {
              return `=== ${path} ===\nError: ${error instanceof Error ? error.message : String(error)}`;
            }
          })
          .join("\n\n"),
    }),
    defineTool({
      name: "search_files",
      description:
        "Find lines containing some text across the application, e.g. a function name.",
      input: z.object({ text: z.string().min(1) }),
      run: ({ text }) => {
        const matches = files.search(text);
        return matches.length > 0
          ? matches
              .map((match) => `${match.path}:${match.line}: ${match.text}`)
              .join("\n")
          : "No matches.";
      },
    }),
    defineTool({
      name: "write_file",
      description:
        "Create or replace a whole file. For a small change to an existing file, use edit_file.",
      input: z.object({
        path: z.string(),
        contents: z.string().describe("The complete file"),
      }),
      run: ({ path, contents }) => {
        files.writeFile(path, contents);
        return `Wrote ${path}.`;
      },
    }),
    defineTool({
      name: "edit_file",
      description:
        "Replace one exact, unique piece of text in a file. Copy old_text from read_file, including whitespace.",
      input: z.object({
        path: z.string(),
        old_text: z.string(),
        new_text: z.string(),
      }),
      run: ({ path, old_text, new_text }) => {
        files.editFile(path, old_text, new_text);
        return `Edited ${path}.`;
      },
    }),
    defineTool({
      name: "delete_file",
      description: "Delete a file this Slice no longer needs.",
      input: z.object({ path: z.string() }),
      run: ({ path }) => {
        files.deleteFile(path);
        return `Deleted ${path}.`;
      },
    }),
  ];
}

/**
 * The live Penpot design, read-only: the screen as drawn, which a human may
 * have adjusted since the UI Spec. The code that reads it is ours, never the
 * model's.
 */
export function penpotTools(
  canvas: Pick<UiCanvas, "describeScreen">,
  pageName: string,
  screens: readonly string[],
): AgentTool[] {
  return [
    defineTool({
      name: INSPECT_SCREEN,
      description:
        "Read a screen from the live Penpot design: every element with its text, position, size and colour. Use it to match the UI exactly.",
      input: z.object({
        screen: z.string().describe(`One of: ${screens.join(", ")}`),
      }),
      run: async ({ screen }) => {
        if (!screens.includes(screen))
          throw new Error(
            `No screen "${screen}". Screens: ${screens.join(", ")}.`,
          );
        const described = await canvas.describeScreen(pageName, screen);
        if (!described)
          throw new Error(
            `Screen "${screen}" is not drawn in Penpot; use the UI Spec.`,
          );
        return describeForModel(described);
      },
    }),
  ];
}

function describeForModel(screen: ScreenDescription): string {
  const lines = screen.elements.map((element) => {
    const text = element.text ? ` "${element.text}"` : "";
    const fill = element.fill ? ` fill ${element.fill}` : "";
    return `- ${element.type} ${element.name}${text} at (${element.x}, ${element.y}) ${element.width}x${element.height}${fill}`;
  });
  return [
    `Screen "${screen.name}" (${screen.width}x${screen.height}):`,
    ...lines,
  ].join("\n");
}
