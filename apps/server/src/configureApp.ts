// SPDX-License-Identifier: MPL-2.0
/**
 * How the server is set up around its modules, in one place, so the tests
 * exercise the same configuration main.ts starts with rather than a copy.
 */
import type { INestApplication } from "@nestjs/common";

/** Loopback only: the server holds API keys and is single-user (grilling Q21). */
export const HOST = "127.0.0.1";

/**
 * Pages on this machine only. The dashboard runs on its own port, so it is
 * another origin; nothing else could reach a loopback server to use it anyway.
 */
const LOCAL_ORIGINS = [
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

export function configureApp(app: INestApplication): INestApplication {
  app.enableCors({ origin: LOCAL_ORIGINS });
  // Stop cleanly on Ctrl-C, so the database and the Penpot connection close.
  app.enableShutdownHooks();
  return app;
}
