// SPDX-License-Identifier: MPL-2.0
/**
 * How the server is set up around its modules, in one place, so the tests
 * exercise the same configuration main.ts starts with rather than a copy.
 */
import type { INestApplication } from "@nestjs/common";
import { accessMiddleware, LOOPBACK } from "./access.js";
import { webMiddleware } from "./staticWeb.js";

/**
 * Loopback unless SDLC_CODE_HOST says otherwise, which needs an access token
 * (access.ts): the server holds API keys and is single-user (grilling Q21).
 */
export const HOST = LOOPBACK;

export type AppOptions = {
  /** Every request but /health must carry it; null on loopback. */
  accessToken?: string | null;
  /** True when the page is served over https, for the cookie's Secure flag. */
  secureCookie?: boolean;
  /** A built dashboard to serve beside the API, which then answers under /api. */
  webDir?: string | null;
};

/**
 * Pages on this machine only. The dashboard runs on its own port, so it is
 * another origin; nothing else could reach a loopback server to use it anyway.
 */
const LOCAL_ORIGINS = [
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

export function configureApp(
  app: INestApplication,
  options: AppOptions = {},
): INestApplication {
  // First, so the dashboard's files and the /api prefix are settled before the
  // sign-in check, which sees the API's own paths.
  if (options.webDir) app.use(webMiddleware(options.webDir));
  app.use(
    accessMiddleware(options.accessToken ?? null, !!options.secureCookie),
  );
  app.enableCors({ origin: LOCAL_ORIGINS });
  // Stop cleanly on Ctrl-C, so the database and the Penpot connection close.
  app.enableShutdownHooks();
  return app;
}
