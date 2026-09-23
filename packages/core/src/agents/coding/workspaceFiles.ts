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
import { basename, dirname, join, relative, sep } from "node:path";
import { isSecretFile } from "../../testRuns/sandboxFiles.js";

/** Never shown or written: git's own files and installed packages. */
const HIDDEN = new Set([".git", "node_modules", "dist", ".sdlc"]);
/** A generated file bigger than this is a mistake, not source code. */
const MAX_FILE_BYTES = 200_000;
export const MAX_LISTED_FILES = 500;
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
    this.#root = realpathSync.native(options.root);
    this.#writable = options.writable;
  }

  listFiles = (directory = ""): string[] => {
    // "", "." and "./" all mean the whole application; agents write all three.
    const whole = ["", ".", "./", "/"].includes(directory.trim());
    const start = whole ? this.#root : this.#check(directory, "read").full;
    if (!existsSync(start) || !statSync(start).isDirectory())
      throw new WorkspaceFileError(`No folder "${directory}".`);
    const files: string[] = [];
    const walk = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (files.length >= MAX_LISTED_FILES) return;
        // Links are not followed: one could lead anywhere.
        if (entry.isSymbolicLink() || isHidden(entry.name)) continue;
        const full = join(folder, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && !isSecretFile(entry.name))
          files.push(relative(this.#root, full).split(sep).join("/"));
      }
    };
    walk(start);
    return files.sort();
  };

  readFile = (path: string): string => {
    const { full } = this.#check(path, "read");
    if (!existsSync(full) || !statSync(full).isFile())
      throw new WorkspaceFileError(`No file "${path}".`);
    const contents = readText(full);
    if (contents === null)
      throw new WorkspaceFileError(
        `"${path}" is not a source file (binary, or over ${MAX_FILE_BYTES} bytes).`,
      );
    return contents;
  };

  writeFile = (path: string, contents: string): void => {
    const { full, path: checked } = this.#check(path, "write");
    if (Buffer.byteLength(contents) > MAX_FILE_BYTES)
      throw new WorkspaceFileError(
        `"${path}" would be ${Buffer.byteLength(contents)} bytes; the limit is ${MAX_FILE_BYTES}. Split it into smaller modules.`,
      );
    if (existsSync(full) && statSync(full).isDirectory())
      throw new WorkspaceFileError(`"${path}" is a folder.`);
    mkdirSync(dirname(full), { recursive: true });
    // Checked again once the folders exist. No tool can create a link, so
    // nothing can swap one in between this check and the write.
    this.#check(path, "write");
    writeFileSync(full, contents);
    this.#changes.set(checked, "written");
  };

  editFile = (path: string, oldText: string, newText: string): void => {
    this.#check(path, "write");
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
    const { full, path: checked } = this.#check(path, "write");
    if (!existsSync(full) || !statSync(full).isFile())
      throw new WorkspaceFileError(`No file "${path}".`);
    rmSync(full);
    this.#changes.set(checked, "deleted");
  };

  search = (text: string): SearchMatch[] => {
    if (text === "") throw new WorkspaceFileError("Search for some text.");
    const matches: SearchMatch[] = [];
    for (const path of this.listFiles()) {
      const contents = readText(join(this.#root, ...path.split("/")));
      if (contents === null) continue;
      for (const [index, line] of contents.split("\n").entries()) {
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

  /**
   * Where `path` really is, or a WorkspaceFileError. The part that exists is
   * resolved on disk first (links, the disk's own casing, Windows short names
   * like GIT~1), and every rule is applied to that real path, so no spelling
   * of a name gets past a check another spelling would fail.
   */
  #check(path: string, access: "read" | "write"): Checked {
    const normal = normalPath(path);
    const full = join(this.#root, ...normal.split("/"));
    const missing: string[] = [];
    let existing = full;
    while (!existsSync(existing)) {
      missing.unshift(basename(existing));
      existing = dirname(existing);
    }
    const real = realpathSync.native(existing);
    if (real !== this.#root && !real.startsWith(this.#root + sep))
      throw new WorkspaceFileError(`"${path}" leads outside the Workspace.`);
    const parts = [
      ...relative(this.#root, real).split(sep).filter(Boolean),
      ...missing,
    ];
    const hidden = parts.find(isHidden);
    if (hidden)
      throw new WorkspaceFileError(
        `"${path}" is inside ${hidden}, which agents do not touch.`,
      );
    const checked = parts.join("/");
    if (isSecretFile(checked))
      throw new WorkspaceFileError(
        access === "read"
          ? `"${path}" holds secrets and is never read.`
          : `"${path}" would hold secrets; write .env.example with placeholder values instead.`,
      );
    if (access === "write" && !this.#mayWrite(checked))
      throw new WorkspaceFileError(
        `You may not write "${path}". You may write: ${this.#writable.join(", ")}.`,
      );
    return { full, path: checked };
  }

  #mayWrite(path: string): boolean {
    const lower = path.toLowerCase();
    return this.#writable.some((writable) =>
      writable.endsWith("/")
        ? lower.startsWith(writable.toLowerCase())
        : lower === writable.toLowerCase(),
    );
  }
}

type Checked = {
  full: string;
  /** "/"-separated, relative, as the disk spells it. */
  path: string;
};

const isHidden = (name: string): boolean => HIDDEN.has(name.toLowerCase());

/** CON, NUL, COM1…: Windows devices, whatever the extension. */
const DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * "/"-separated and relative, or a WorkspaceFileError saying why not. Names
 * Windows would read differently from how they are written are refused:
 * trailing dots and spaces, "name:stream", devices and 8.3 short names.
 */
function normalPath(path: string): string {
  const refuse = (why: string): never => {
    throw new WorkspaceFileError(
      `"${path}" is not a path inside the Workspace (${why}); use a relative path like "server/todos.ts".`,
    );
  };
  // eslint-disable-next-line no-control-regex
  if (/[:\x00-\x1f]/.test(path))
    refuse("no drive letters, streams or control characters");
  const parts = path.replaceAll("\\", "/").replace(/^\.\//, "").split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..")
      refuse("no empty, . or .. parts");
    if (/^\s|[\s.]$/.test(part))
      refuse("no names starting with a space or ending in a space or dot");
    if (DEVICE_NAME.test(part)) refuse("no device names");
    if (/~\d/.test(part)) refuse("no short names");
  }
  return parts.join("/");
}

/** A file's text, or null if it is too big or not text. */
function readText(full: string): string | null {
  if (statSync(full).size > MAX_FILE_BYTES) return null;
  const contents = readFileSync(full, "utf8");
  return contents.includes("\0") ? null : contents;
}
