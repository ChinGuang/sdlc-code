/**
 * What a unified diff shows, line by line (T25a). The Code Review Agent's
 * Findings are checked against it: a Finding about a file or a line the diff
 * does not show, or one that quotes code it does not contain, cannot be right.
 * Found in T25, where false blocking Findings ("component incomplete, missing
 * imports", for files that were complete) sent a passing Slice back.
 */

/** A file's lines as the diff shows them: added and context lines, by new line number. */
export type ShownFile = Map<number, string>;

/** Every file the diff shows, by its path after the change. */
export type ShownDiff = Map<string, ShownFile>;

const NEW_FILE = /^\+\+\+ (?:b\/)?(.*)$/;
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
        const path = named[1]!.trim();
        if (path !== "/dev/null") {
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

/** Whitespace-insensitive, since a model re-indents what it quotes. */
const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** How far from the cited line a quote may be found: models miscount by a line or two. */
const LINE_SLACK = 2;

/**
 * Whether `quote` is code the diff shows at the cited line, or within a couple
 * of lines of it; line 0 (the file as a whole) accepts any line of the file.
 */
export function quoteIsShown(
  file: ShownFile,
  line: number,
  quote: string,
): boolean {
  const wanted = squash(quote);
  if (wanted === "") return false;
  for (const [at, text] of file)
    if (
      (line === 0 || Math.abs(at - line) <= LINE_SLACK) &&
      squash(text).includes(wanted)
    )
      return true;
  return false;
}
