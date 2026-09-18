import { createAppServer } from "./server.js";

const port = Number(process.env.SDLC_CODE_PORT ?? 4317);
// Bind to loopback only: the server holds API keys and is single-user (grilling Q21).
createAppServer().listen(port, "127.0.0.1", () => {
  console.log(`sdlc-code server on http://127.0.0.1:${port}`);
});
