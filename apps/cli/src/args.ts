/**
 * The command line, split into what was said and how: positional words and
 * `--flags`, each flag either a switch or a value. No library, because the
 * grammar is this small.
 */

/** A mistake in what was typed: exit code 2, and the help that fixes it. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type Parsed = {
  words: string[];
  flags: Map<string, string | true>;
};

/**
 * Splits argv. `valued` names the flags that take a value (`--budget 3M` or
 * `--budget=3M`); every other flag is a switch. `--` ends the flags, so a
 * hint may start with a dash.
 */
export function parseArgs(
  argv: readonly string[],
  valued: ReadonlySet<string>,
): Parsed {
  const words: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      words.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [
      string,
      string | undefined,
    ];
    if (!valued.has(name)) {
      if (inline !== undefined)
        throw new UsageError(`--${name} takes no value.`);
      flags.set(name, true);
      continue;
    }
    const value = inline ?? argv[index + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--")))
      throw new UsageError(`--${name} needs a value.`);
    flags.set(name, value);
    if (inline === undefined) index += 1;
  }
  return { words, flags };
}

/** Only the flags a command knows; a typo is not silently ignored. */
export function onlyFlags(parsed: Parsed, known: readonly string[]): void {
  for (const name of parsed.flags.keys())
    if (!known.includes(name))
      throw new UsageError(`Unknown option --${name}.`);
}

/** "3M", "1.5M", "500k", "2,000,000" or "2000000", as tokens. */
export function parseTokens(text: string): number {
  // Commas only between groups of three: "1,5M" is not a way to write 1.5M.
  const match = /^(\d{1,3}(?:,\d{3})+|[\d_]+(?:\.\d+)?)\s*([kKmM]?)$/.exec(
    text.trim(),
  );
  const number = match ? Number(match[1]!.replace(/[,_]/g, "")) : Number.NaN;
  const scale =
    match?.[2]?.toLowerCase() === "m"
      ? 1_000_000
      : match?.[2]?.toLowerCase() === "k"
        ? 1_000
        : 1;
  const tokens = Math.round(number * scale);
  if (!Number.isFinite(tokens) || tokens <= 0)
    throw new UsageError(
      `"${text}" is not a number of tokens; try 2000000, 2M or 500k.`,
    );
  return tokens;
}
