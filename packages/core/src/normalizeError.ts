/**
 * Text as it reads once what changes between runs is taken out: what makes
 * one failure the same as the next (a Loop, a check that failed again), in
 * the agent loop as in the Issue Reports.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (text: string): string => text.replace(ANSI, "");

/**
 * What stays the same when the same failure happens again: the error without
 * what varies between runs. Timestamps first, then ids, then timings and line
 * numbers, so one rule never leaves part of another's match behind.
 */
export function normalizeError(error: string): string {
  return (
    stripAnsi(error)
      .replace(
        /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?/g,
        "<timestamp>",
      )
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        "<uuid>",
      )
      // A hex id has a letter in it; a plain number is part of the error.
      .replace(/\b(?=[0-9]*[a-f])[0-9a-f]{8,}\b/gi, "<id>")
      .replace(/\b\d+(\.\d+)?\s?(ms|s)\b/g, "<time>")
      .replace(/:\d+:\d+\b/g, ":<line>")
      .replace(/\s+/g, " ")
      .trim()
  );
}
