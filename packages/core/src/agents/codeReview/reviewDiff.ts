// SPDX-License-Identifier: MPL-2.0
/**
 * What a unified diff shows, line by line (T25a). The Code Review Agent's
 * Findings are checked against it: a Finding about a file or a line the diff
 * does not show, or one that quotes code it does not contain, cannot be right.
 * Found in T25, where false blocking Findings ("component incomplete, missing
 * imports", for files that were complete) sent a passing Slice back.
 *
 * It reads what WorkspaceManager.runDiff writes: git's default `a/` and `b/`
 * prefixes, which runDiff pins, and paths git may quote.
 */

/** A file's lines as the diff shows them: added and context lines, by new line number. */
export type ShownFile = Map<number, string>;

/** Every file the diff shows, by its path after the change. */
export type ShownDiff = Map<string, ShownFile>;

const NEW_FILE = /^\+\+\+ (.*)$/;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The lines a diff shows of each file it changes. A deleted file shows none; a
 * line the diff removes is not in the new file, so it is not shown either.
 */
export function shownByDiff(diff: string): ShownDiff {
  const shown: ShownDiff = new Map();
  let file: ShownFile | null = null;
  let inHeader = false;
  let line = 0;
  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git ")) {
      inHeader = true;
      file = null;
      continue;
    }
    if (inHeader) {
      const named = NEW_FILE.exec(text);
      if (named) {
        const path = newPath(named[1]!);
        if (path !== null) {
          file = new Map();
          shown.set(path, file);
        }
        continue;
      }
      const hunk = HUNK.exec(text);
      if (hunk) {
        inHeader = false;
        line = Number(hunk[1]);
      }
      continue;
    }
    const hunk = HUNK.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    // "\ No newline at end of file" belongs to no line of either side.
    if (text.startsWith("\\")) continue;
    if (text.startsWith("-")) continue;
    if (text.startsWith("+") || text.startsWith(" ")) {
      file.set(line, text.slice(1));
      line++;
    }
  }
  return shown;
}

/**
 * The path a `+++` header names, without its `b/`: null for /dev/null (a
 * deleted file) and for anything git did not prefix. Git quotes a path with
 * a quote, a tab or a non-ASCII character, in C style: "b/caf\303\251.ts".
 */
function newPath(header: string): string | null {
  const named = header.trim();
  const path = named.startsWith('"') ? unquote(named) : named;
  return path.startsWith("b/") ? path.slice(2) : null;
}

const ESCAPES: Record<string, string> = {
  t: "\t",
  n: "\n",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

/** A C-style quoted path to its text; octal escapes are UTF-8 bytes. */
function unquote(quoted: string): string {
  const body = quoted.replace(/^"/, "").replace(/"$/, "");
  const bytes: number[] = [];
  for (let at = 0; at < body.length; at++) {
    const char = body[at]!;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(at + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      at += 3;
    } else {
      bytes.push(
        ...Buffer.from(ESCAPES[body[at + 1]!] ?? body[at + 1] ?? "", "utf8"),
      );
      at += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Whitespace-insensitive, since a model re-indents what it quotes. */
const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** How far from the cited line a quote may be found: models miscount by a line or two. */
const LINE_SLACK = 2;

/**
 * Whether `quote` is code the diff shows at the cited line, or within a couple
 * of lines of it; line 0 (the file as a whole) accepts any line of the file. A
 * quote of several lines matches the same lines, one after the other.
 */
export function quoteIsShown(
  file: ShownFile,
  line: number,
  quote: string,
): boolean {
  const wanted = squash(quote);
  if (wanted === "") return false;
  const length = quote.split("\n").length;
  for (const start of file.keys()) {
    if (line !== 0 && Math.abs(start - line) > LINE_SLACK) continue;
    let text = "";
    for (let at = start; at < start + length && file.has(at); at++)
      text += ` ${file.get(at)}`;
    if (squash(text).includes(wanted)) return true;
  }
  return false;
}
