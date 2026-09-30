import { HttpServerApi } from "./api.js";
import { runCli } from "./cli.js";
import { COLOUR, PLAIN } from "./format.js";

// Colour only for a person at a terminal, and never when they asked for none.
const colour = process.stdout.isTTY && !process.env.NO_COLOR;

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
    paint: colour ? COLOUR : PLAIN,
    dashboardUrl: process.env.SDLC_DASHBOARD_URL ?? "http://localhost:5173",
  },
);
