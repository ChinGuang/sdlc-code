// SPDX-License-Identifier: MPL-2.0
/**
 * Protects the application's package.json from a Coding Agent rewriting it.
 * Seen live: an agent wrote the whole manifest back with vitest downgraded to
 * 0.30.1 and a new mock library that needs vitest 2, so npm install failed with
 * ERESOLVE, no Issue Report had an owner, and the Run escalated out with
 * nothing built.
 *
 * Adding a dependency or a script is allowed; changing or removing what the
 * template and the earlier Slices rely on is not.
 */

const KEPT_MAPS = ["dependencies", "devDependencies", "scripts"] as const;

export const MANIFEST_PATH = "package.json";

type Manifest = Record<string, unknown>;

/** Why this manifest may not be written, or null when it may. */
export function manifestChangeProblem(
  before: string,
  after: string,
): string | null {
  const old = parse(before);
  const next = parse(after);
  if (!next) return "package.json must stay a JSON object.";
  // Nothing to protect: a manifest that was not readable before is being fixed.
  if (!old) return null;

  const problems: string[] = [];
  for (const section of KEPT_MAPS) {
    const kept = entries(old[section]);
    const now = entries(next[section]);
    for (const [name, value] of kept) {
      const replacement = now.get(name);
      if (replacement === undefined)
        problems.push(`${section}.${name} was removed`);
      else if (replacement !== value)
        problems.push(
          `${section}.${name} was changed from ${value} to ${replacement}`,
        );
    }
  }
  if (problems.length === 0) return null;
  return `package.json keeps what the application already depends on; ${problems.join(", ")}. Add a new entry if you need one, and leave the rest exactly as it is.`;
}

function parse(text: string): Manifest | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Manifest)
      : null;
  } catch {
    return null;
  }
}

/** A manifest section as a map; anything that is not a string map is empty. */
function entries(section: unknown): Map<string, string> {
  if (typeof section !== "object" || section === null || Array.isArray(section))
    return new Map();
  return new Map(
    Object.entries(section).flatMap(([name, value]) =>
      typeof value === "string" ? [[name, value] as [string, string]] : [],
    ),
  );
}
