export type CliIo = {
  out: (line: string) => void;
  err: (line: string) => void;
};

const VERSION = "0.0.0";

const HELP = `Usage: sdlccode [options]

Options:
  --help       Show this help
  --version    Show the version`;

/** Parses argv and runs a command; returns the process exit code. */
export function runCli(argv: string[], io: CliIo): number {
  const [first] = argv;
  if (first === undefined || first === "--help" || first === "-h") {
    io.out(HELP);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    io.out(`sdlccode ${VERSION}`);
    return 0;
  }
  io.err(`Unknown command: ${first}\n\n${HELP}`);
  return 2;
}
