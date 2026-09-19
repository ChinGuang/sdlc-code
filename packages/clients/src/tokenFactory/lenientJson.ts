/**
 * JSON.parse with one narrow repair: the closing brackets at the very end.
 * Nemotron on Token Factory sometimes serialises nested tool arguments with one
 * closer too many or too few at the end (e.g. `…}]]`); seen live in T09. The
 * content before them is untouched, so nothing is guessed.
 */

const MAX_REPAIR = 3;

/** Parses `text` as JSON, repairing up to 3 extra or missing closing brackets at the end. */
export function parseJsonLeniently(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (original) {
    const trimmed = text.trimEnd();

    let candidate = trimmed;
    for (let i = 0; i < MAX_REPAIR && /[\]}]$/.test(candidate); i++) {
      candidate = candidate.slice(0, -1).trimEnd();
      const parsed = tryParse(candidate);
      if (parsed.ok) return parsed.value;
    }

    const closers = missingClosers(trimmed);
    if (
      closers !== null &&
      closers.length > 0 &&
      closers.length <= MAX_REPAIR
    ) {
      const parsed = tryParse(trimmed + closers);
      if (parsed.ok) return parsed.value;
    }
    throw original;
  }
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** The closers that would balance `text`, or null if it is not a clean prefix. */
function missingClosers(text: string): string | null {
  const open: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") open.push("}");
    else if (char === "[") open.push("]");
    else if (char === "}" || char === "]") {
      if (open.pop() !== char) return null;
    }
  }
  return inString ? null : open.reverse().join("");
}
