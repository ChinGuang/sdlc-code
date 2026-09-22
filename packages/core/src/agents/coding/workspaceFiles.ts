/**
 * A Coding Agent's view of its Workspace (CONTEXT.md): it reads the whole
 * application and writes only its own part of it. Every path is checked here,
 * so no tool call, however its arguments were written, can reach outside the
 * Workspace, into git, or into a secret file.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { isSecretFile } from "../../testRuns/sandboxFiles.js";

/** Never shown or written: git's own files and installed packages. */
const HIDDEN = new Set([".git", "node_modules", "dist", ".sdlc"]);
/** A generated file bigger than this is a mistake, not source code. */
const MAX_FILE_BYTES = 200_000;
const MAX_LISTED_FILES = 500;
const MAX_SEARCH_MATCHES = 100;

export type FileChange = { path: string; kind: "written" | "deleted" };

export type SearchMatch = { path: string; line: number; text: string };

export type WorkspaceFilesOptions = {
  /** The Workspace's worktree. */
  root: string;
  /** Folders ("server/") or files ("package.json") this agent may write. */
  writable: readonly string[];
};

/** The files of one Workspace, as one Coding Agent may use them. */
export interface WorkspaceFiles {
  /** Every file under `directory` ("" for all), as "/"-separated paths. */
  listFiles: (directory?: string) => string[];
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
  /** Replaces the one occurrence of `oldText`; fails if it is missing or repeated. */
  editFile: (path: string, oldText: string, newText: string) => void;
  deleteFile: (path: string) => void;
  /** Lines containing `text`, case-sensitive. */
  search: (text: string) => SearchMatch[];
  /** What this agent changed, in order; a file appears once, as it ended. */
  changes: () => FileChange[];
}

export class WorkspaceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

export class LocalWorkspaceFiles implements WorkspaceFiles {
  #root: string;
  #writable: readonly string[];
  #changes = new Map<string, FileChange["kind"]>();

  constructor(options: WorkspaceFilesOptions) {
    this.#root = realpathSync(options.root);
    this.#writable = options.writable;
  }

  listFiles = (directory = ""): string[] => {
    const start = directory === "" ? this.#root : this.#resolve(directory);
    if (!existsSync(start) || !statSync(start).isDirectory())
      throw new WorkspaceFileError(`No folder "${directory}".`);
    const files: string[] = [];
    const walk = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (HIDDEN.has(entry.name) || files.length >= MAX_LISTED_FILES)
          continue;
        const full = join(folder, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && !isSecretFile(entry.name))
          files.push(this.#relative(full));
      }
    };
    walk(start);
    return files.sort();
  };

  readFile = (path: string): string => {
    const full = this.#resolve(path);
    if (isSecretFile(path))
      throw new WorkspaceFileError(
        `"${path}" holds secrets and is never read.`,
      );
    if (!existsSync(full) || !statSync(full).isFile())
      throw new WorkspaceFileError(`No file "${path}".`);
    return readFileSync(full, "utf8");
  };

  writeFile = (path: string, contents: string): void => {
    const full = this.#resolveWritable(path);
    if (Buffer.byteLength(contents) > MAX_FILE_BYTES)
      throw new WorkspaceFileError(
        `"${path}" would be ${Buffer.byteLength(contents)} bytes; the limit is ${MAX_FILE_BYTES}. Split it into smaller modules.`,
      );
    if (existsSync(full) && statSync(full).isDirectory())
      throw new WorkspaceFileError(`"${path}" is a folder.`);
    mkdirSync(dirname(full), { recursive: true });
    // Resolved again after creating folders: a new folder could be a link.
    this.#resolveWritable(path);
    writeFileSync(full, contents);
    this.#changes.set(this.#normal(path), "written");
  };

  editFile = (path: string, oldText: string, newText: string): void => {
    this.#resolveWritable(path);
    if (oldText === "")
      throw new WorkspaceFileError(
        "old_text is empty; use write_file to create a file.",
      );
    const contents = this.readFile(path);
    const first = contents.indexOf(oldText);
    if (first === -1)
      throw new WorkspaceFileError(
        `old_text was not found in "${path}". Read the file again and copy the text exactly.`,
      );
    if (contents.indexOf(oldText, first + 1) !== -1)
      throw new WorkspaceFileError(
        `old_text appears more than once in "${path}". Include more surrounding lines so it is unique.`,
      );
    this.writeFile(
      path,
      contents.slice(0, first) +
        newText +
        contents.slice(first + oldText.length),
    );
  };

  deleteFile = (path: string): void => {
    const full = this.#resolveWritable(path);
    if (!existsSync(full) || !statSync(full).isFile())
      throw new WorkspaceFileError(`No file "${path}".`);
    rmSync(full);
    this.#changes.set(this.#normal(path), "deleted");
  };

  search = (text: string): SearchMatch[] => {
    if (text === "") throw new WorkspaceFileError("Search for some text.");
    const matches: SearchMatch[] = [];
    for (const path of this.listFiles()) {
      const lines = readFileSync(join(this.#root, path), "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (!line.includes(text)) continue;
        matches.push({
          path,
          line: index + 1,
          text: line.trim().slice(0, 200),
        });
        if (matches.length >= MAX_SEARCH_MATCHES) return matches;
      }
    }
    return matches;
  };

  changes = (): FileChange[] =>
    [...this.#changes].map(([path, kind]) => ({ path, kind }));

  /** The full path of `path`, provided it stays inside the Workspace. */
  #resolve(path: string): string {
    const normal = this.#normal(path);
    const full = join(this.#root, ...normal.split("/"));
    // A link inside the Workspace must not lead outside it.
    let existing = full;
    while (!existsSync(existing)) existing = dirname(existing);
    const real = realpathSync(existing);
    if (real !== this.#root && !real.startsWith(this.#root + sep))
      throw new WorkspaceFileError(`"${path}" leads outside the Workspace.`);
    return full;
  }

  #resolveWritable(path: string): string {
    const full = this.#resolve(path);
    const normal = this.#normal(path);
    if (isSecretFile(normal))
      throw new WorkspaceFileError(
        `"${path}" would hold secrets; write .env.example with placeholder values instead.`,
      );
    const allowed = this.#writable.some((writable) =>
      writable.endsWith("/")
        ? normal.startsWith(writable)
        : normal === writable,
    );
    if (!allowed)
      throw new WorkspaceFileError(
        `You may not write "${path}". You may write: ${this.#writable.join(", ")}.`,
      );
    return full;
  }

  /** "/"-separated and relative, or a WorkspaceFileError saying why not. */
  #normal(path: string): string {
    const slashed = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    const parts = slashed.split("/");
    if (
      slashed === "" ||
      slashed.startsWith("/") ||
      /^[A-Za-z]:/.test(slashed) ||
      parts.some((part) => part === "" || part === "." || part === "..")
    )
      throw new WorkspaceFileError(
        `"${path}" is not a path inside the Workspace; use a relative path like "server/todos.ts".`,
      );
    if (parts.some((part) => HIDDEN.has(part)))
      throw new WorkspaceFileError(
        `"${path}" is inside ${parts.find((part) => HIDDEN.has(part))}, which agents do not touch.`,
      );
    return parts.join("/");
  }

  #relative(full: string): string {
    return relative(this.#root, full).split(sep).join("/");
  }
}
