import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalWorkspaceFiles, type WorkspaceFiles } from "./workspaceFiles.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function place(root: string, path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

/** A Workspace beside a folder it must never reach. */
function setup(writable: readonly string[] = ["server/", "package.json"]) {
  const base = mkdtempSync(join(tmpdir(), "sdlc-files-"));
  folders.push(base);
  const root = join(base, "workspace");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  place(root, "package.json", '{ "name": "app" }\n');
  place(root, "server/app.ts", "export const app = 1;\nexport const b = 2;\n");
  place(root, "src/App.tsx", "export const App = () => null;\n");
  place(root, ".git", "gitdir: elsewhere\n");
  place(root, "node_modules/x/index.js", "x");
  place(root, ".env", "NEBIUS_API_KEY=secret-key-123\n");
  place(outside, "secret.txt", "outside");
  // Tests depend on the interface; only this factory knows the class.
  const files: WorkspaceFiles = new LocalWorkspaceFiles({ root, writable });
  return { files, root, outside };
}

describe("LocalWorkspaceFiles reading", () => {
  it("lists the application's files, not git, packages or secrets", () => {
    const { files } = setup();

    expect(files.listFiles()).toEqual([
      "package.json",
      "server/app.ts",
      "src/App.tsx",
    ]);
    expect(files.listFiles("server")).toEqual(["server/app.ts"]);
  });

  it("reads any application file, including the other side's", () => {
    const { files } = setup();

    expect(files.readFile("src/App.tsx")).toBe(
      "export const App = () => null;\n",
    );
    expect(files.readFile("./server\\app.ts")).toContain("app = 1");
  });

  it("never reads a secret file into the model's context", () => {
    const { files } = setup();

    expect(() => files.readFile(".env")).toThrow(/never read/);
  });

  it("finds text across files", () => {
    const { files } = setup();

    expect(files.search("const b")).toEqual([
      { path: "server/app.ts", line: 2, text: "export const b = 2;" },
    ]);
  });
});

describe("LocalWorkspaceFiles cannot reach outside the Workspace", () => {
  const escapes = [
    "../outside/secret.txt",
    "server/../../outside/secret.txt",
    "..\\outside\\secret.txt",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "C:\\Windows\\win.ini",
    "",
    "server//app.ts",
  ];

  it.each(escapes)("refuses to read %j", (path) => {
    const { files } = setup();

    expect(() => files.readFile(path)).toThrow(/not a path inside/);
  });

  it.each(escapes)("refuses to write %j", (path) => {
    const { files, outside } = setup();

    expect(() => files.writeFile(path, "pwned")).toThrow(/not a path inside/);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside");
  });

  it("refuses git's files and installed packages", () => {
    const { files } = setup(["server/", ".git", "node_modules/"]);

    expect(() => files.writeFile(".git", "x")).toThrow(/\.git/);
    expect(() => files.writeFile(".git/hooks/pre-commit", "x")).toThrow(
      /\.git/,
    );
    expect(() => files.writeFile("node_modules/x/index.js", "x")).toThrow(
      /node_modules/,
    );
    expect(() => files.readFile("server/.git/config")).toThrow(/\.git/);
  });

  it("refuses a link that leads outside", () => {
    const { files, root, outside } = setup();
    // A junction needs no admin rights on Windows; elsewhere it is a symlink.
    symlinkSync(outside, join(root, "server", "linked"), "junction");

    expect(() => files.readFile("server/linked/secret.txt")).toThrow(
      /leads outside/,
    );
    expect(() => files.writeFile("server/linked/new.ts", "x")).toThrow(
      /leads outside/,
    );
    expect(existsSync(join(outside, "new.ts"))).toBe(false);
  });
});

describe("LocalWorkspaceFiles writing", () => {
  it("writes only where this agent may", () => {
    const { files, root } = setup();

    files.writeFile("server/todos.ts", "export const todos = [];\n");
    files.writeFile("package.json", "{}\n");

    expect(readFileSync(join(root, "server/todos.ts"), "utf8")).toBe(
      "export const todos = [];\n",
    );
    expect(() => files.writeFile("src/App.tsx", "x")).toThrow(
      /may not write "src\/App.tsx"\. You may write: server\/, package.json/,
    );
    expect(() => files.writeFile("package.json.bak", "x")).toThrow(
      /may not write/,
    );
    expect(() => files.writeFile("serverx/a.ts", "x")).toThrow(/may not write/);
  });

  it("never writes a secret file", () => {
    const { files } = setup(["server/", ".env"]);

    expect(() => files.writeFile("server/.env", "KEY=x")).toThrow(
      /would hold secrets/,
    );
    expect(() => files.writeFile(".env", "KEY=x")).toThrow(
      /would hold secrets/,
    );
  });

  it("refuses a file too big to be source code", () => {
    const { files } = setup();

    expect(() =>
      files.writeFile("server/huge.ts", "x".repeat(200_001)),
    ).toThrow(/limit is 200000/);
  });

  it("edits one exact, unique piece of text", () => {
    const { files } = setup();

    files.editFile("server/app.ts", "app = 1", "app = 10");

    expect(files.readFile("server/app.ts")).toBe(
      "export const app = 10;\nexport const b = 2;\n",
    );
    expect(() => files.editFile("server/app.ts", "missing", "x")).toThrow(
      /not found/,
    );
    expect(() => files.editFile("server/app.ts", "export const", "x")).toThrow(
      /more than once/,
    );
    expect(() => files.editFile("src/App.tsx", "App", "X")).toThrow(
      /may not write/,
    );
  });

  it("deletes a file it may write", () => {
    const { files, root } = setup();

    files.deleteFile("server/app.ts");

    expect(existsSync(join(root, "server/app.ts"))).toBe(false);
    expect(() => files.deleteFile("src/App.tsx")).toThrow(/may not write/);
  });

  it("records what changed, each file once as it ended", () => {
    const { files } = setup();

    files.writeFile("server/todos.ts", "a");
    files.editFile("server/todos.ts", "a", "b");
    files.deleteFile("server/app.ts");

    expect(files.changes()).toEqual([
      { path: "server/todos.ts", kind: "written" },
      { path: "server/app.ts", kind: "deleted" },
    ]);
  });
});
