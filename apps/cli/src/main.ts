import { HttpServerApi } from "./api.js";
import { runCli } from "./cli.js";
import { COLOUR, PLAIN } from "./format.js";

// Colour only for a person at a terminal, and never when they asked for none.
const colour = (stream: NodeJS.WriteStream) =>
  stream.isTTY && !process.env.NO_COLOR ? COLOUR : PLAIN;

process.exitCode = await runCli(
  process.argv.slice(2),
  {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  },
  {
    api: new HttpServerApi({
      baseUrl: process.env.SDLC_API_URL ?? "http://127.0.0.1:4317",
    }),
    paint: colour(process.stdout),
    errPaint: colour(process.stderr),
    dashboardUrl: process.env.SDLC_DASHBOARD_URL ?? "http://localhost:5173",
  },
);
