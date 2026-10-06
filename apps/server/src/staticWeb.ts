// SPDX-License-Identifier: MPL-2.0
/**
 * Serves the built dashboard from the same server (S2), so a container is one
 * process on one port. Requests under /api go to the API with the prefix
 * stripped, as the dev server's proxy does; anything else is a file of the
 * build, or index.html for a route of the single-page app.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { NextFunction } from "./access.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

type WebRequest = { method: string; url: string; path: string };
type WebResponse = {
  status: (code: number) => WebResponse;
  setHeader: (name: string, value: string) => unknown;
  end: (body?: Buffer) => unknown;
};

/** `/api/runs` → `/runs`; null for a path that is not the API's. */
export function stripApiPrefix(url: string): string | null {
  return /^\/api(?=\/|\?|$)/.test(url)
    ? url.replace(/^\/api/, "") || "/"
    : null;
}

/** The file of `root` a request path names, or null if it names none inside it. */
export function fileFor(dir: string, urlPath: string): string | null {
  // "/app/dist/" and "/app/dist" are the same folder.
  const root = normalize(dir).replace(/[\\/]+$/, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0] ?? "");
  } catch {
    return null;
  }
  const full = normalize(join(root, decoded));
  // No walking out of the build with "..".
  if (full !== root && !full.startsWith(root + sep)) return null;
  return existsSync(full) && statSync(full).isFile() ? full : null;
}

/** Express middleware: the API prefix, then the build's files. */
export function webMiddleware(root: string) {
  const index = join(root, "index.html");
  return (
    request: WebRequest,
    response: WebResponse,
    next: NextFunction,
  ): void => {
    const api = stripApiPrefix(request.url);
    if (api !== null) {
      request.url = api;
      return next();
    }
    if (request.method !== "GET" && request.method !== "HEAD") return next();
    const named = fileFor(root, request.path);
    // A path with an extension that is no file of the build is a missing file,
    // not a route of the app: 404, not the page again.
    if (!named && extname(request.path) !== "") return next();
    const file = named ?? index;
    if (!existsSync(file)) return next();
    response.status(200);
    response.setHeader(
      "Content-Type",
      TYPES[extname(file)] ?? "application/octet-stream",
    );
    // Built files are named by their content: cache them, never the page.
    response.setHeader(
      "Cache-Control",
      file === index ? "no-cache" : "public, max-age=31536000, immutable",
    );
    response.end(request.method === "HEAD" ? undefined : readFileSync(file));
  };
}
