/**
 * Backend and frontend both add dependencies and scripts to package.json in
 * the same Slice. Their lines sit next to each other, so git reports a
 * conflict where there is none; this merges the manifest by key instead.
 */

/** Sections where each side adds its own entries. */
const KEYED_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "scripts",
] as const;

type Manifest = Record<string, unknown>;

/**
 * A three-way merge of package.json: each key takes the side that changed it.
 * Null when both sides changed the same key differently, or a file is not a
 * JSON object: that is a real conflict for its owner to resolve.
 */
export function mergePackageJson(
  base: string,
  ours: string,
  theirs: string,
): string | null {
  const [baseJson, oursJson, theirsJson] = [base, ours, theirs].map(parse);
  if (!baseJson || !oursJson || !theirsJson) return null;
  const merged = mergeObjects(baseJson, oursJson, theirsJson, (key) =>
    (KEYED_SECTIONS as readonly string[]).includes(key),
  );
  if (!merged) return null;
  // npm keeps dependency lists sorted; scripts keep the order people wrote.
  for (const section of KEYED_SECTIONS.filter((key) => key !== "scripts")) {
    const value = merged[section];
    if (isObject(value)) merged[section] = sortKeys(value);
  }
  const indent = /^\{\r?\n(\s+)/.exec(ours)?.[1] ?? "  ";
  return `${JSON.stringify(merged, null, indent)}\n`;
}

/** Merges key by key; `nested` keys are merged one level deeper. */
function mergeObjects(
  base: Manifest,
  ours: Manifest,
  theirs: Manifest,
  nested: (key: string) => boolean = () => false,
): Manifest | null {
  const merged: Manifest = {};
  // Our key order first, then keys only they added, then removed ones.
  const keys = new Set([
    ...Object.keys(ours),
    ...Object.keys(theirs),
    ...Object.keys(base),
  ]);
  for (const key of keys) {
    const [b, o, t] = [base[key], ours[key], theirs[key]];
    if (nested(key) && [b, o, t].every((v) => v === undefined || isObject(v))) {
      const inner = mergeObjects(
        (b as Manifest) ?? {},
        (o as Manifest) ?? {},
        (t as Manifest) ?? {},
      );
      if (!inner) return null;
      if (o !== undefined || t !== undefined) merged[key] = inner;
      continue;
    }
    const value = pick(b, o, t);
    if (value === CONFLICT) return null;
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

const CONFLICT = Symbol("conflict");

/** The value a key ends with; undefined means removed. */
function pick(base: unknown, ours: unknown, theirs: unknown): unknown {
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (same(base, theirs)) return ours;
  return CONFLICT;
}

function parse(text: string): Manifest | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Manifest {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Sorted by code point, as npm writes them. */
function sortKeys(value: Manifest): Manifest {
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
