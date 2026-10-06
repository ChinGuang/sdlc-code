// SPDX-License-Identifier: MPL-2.0
/**
 * Who may use the server (S2). On this machine it listens on loopback and needs
 * no sign-in. Anywhere else it holds API keys and spends money, so it listens
 * beyond loopback only when an access token is set, and then every request
 * must carry it: as a Bearer header, or as the cookie that POST /session sets
 * for the dashboard (an EventSource cannot send a header).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** The parts of an Express request, response and next that this file uses. */
export type Request = {
  method: string;
  path: string;
  headers: {
    authorization?: string;
    cookie?: string;
    "content-type"?: string;
  };
  on: (event: string, listener: (...args: never[]) => void) => unknown;
  destroy: () => unknown;
};
export type Response = {
  status: (code: number) => Response;
  json: (body: unknown) => unknown;
  end: () => unknown;
  setHeader: (name: string, value: string) => unknown;
};
export type NextFunction = () => void;

export const LOOPBACK = "127.0.0.1";
export const SESSION_COOKIE = "sdlc_session";
/** A token shorter than this is guessable; the server refuses to start with it. */
export const MIN_TOKEN_LENGTH = 16;

export type AccessSettings = {
  host: string;
  /** Null: no sign-in, which is only allowed on loopback. */
  token: string | null;
};

export class AccessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessConfigError";
  }
}

/** Reads SDLC_CODE_HOST and SDLC_ACCESS_TOKEN; refuses an open server off loopback. */
export function accessSettings(
  env: Record<string, string | undefined>,
): AccessSettings {
  const host = env.SDLC_CODE_HOST || LOOPBACK;
  const token = env.SDLC_ACCESS_TOKEN || null;
  if (token !== null && token.length < MIN_TOKEN_LENGTH)
    throw new AccessConfigError(
      `SDLC_ACCESS_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.`,
    );
  if (host !== LOOPBACK && token === null)
    throw new AccessConfigError(
      `SDLC_CODE_HOST=${host} would put a server that holds API keys on the network with no sign-in: set SDLC_ACCESS_TOKEN, or leave the host on ${LOOPBACK}.`,
    );
  return { host, token };
}

/** Equal tokens, in time that does not say how many leading characters matched. */
export function sameToken(given: string, expected: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      // "%" alone is no value we ever set: not signed in, not a server error.
      return null;
    }
  }
  return null;
}

/**
 * What the browser keeps instead of the token: a value only the token makes, so
 * a cookie that leaks (a shared machine, a proxy's log) is not the token itself
 * and cannot be used as a Bearer header. It is still a way in until it expires.
 */
export function sessionValue(token: string): string {
  return createHmac("sha256", token).update("sdlc-code session").digest("hex");
}

/** Whether a request carries the token, or the session value that signing in gave. */
export function isSignedIn(request: Request, token: string): boolean {
  const authorization = request.headers.authorization;
  if (authorization?.toLowerCase().startsWith("bearer "))
    return sameToken(authorization.slice("bearer ".length).trim(), token);
  const cookie = cookieValue(request.headers.cookie, SESSION_COOKIE);
  return cookie !== null && sameToken(cookie, sessionValue(token));
}

const bodyOf = (request: Request): Promise<string> =>
  new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > 4096) request.destroy();
    });
    request.on("end", () => resolve(text));
    request.on("error", () => resolve(""));
    // A destroyed request ends with neither: the answer must still be sent.
    request.on("close", () => resolve(text));
  });

/**
 * Express middleware: answers `GET /session` (is a sign-in needed, and is this
 * request signed in), `POST /session` (sign in: sets the cookie) and
 * `DELETE /session`, lets `/health` through, and turns every other request
 * without the token away with 401. Does nothing when there is no token.
 */
export function accessMiddleware(token: string | null, secure: boolean) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (token === null) return next();
    const signedIn = isSignedIn(request, token);
    const path = request.path;

    if (path === "/session") {
      if (request.method === "GET") {
        response.json({ required: true, signedIn });
        return;
      }
      if (request.method === "DELETE") {
        response.setHeader("Set-Cookie", sessionCookie("", secure, 0));
        response.status(204).end();
        return;
      }
      if (request.method === "POST") {
        void bodyOf(request).then((text) => {
          let supplied = "";
          try {
            supplied = String((JSON.parse(text) as { token?: unknown }).token);
          } catch {
            // Not JSON: it is not a token either.
          }
          if (!sameToken(supplied, token)) {
            response.status(401).json({ message: "That token is not right." });
            return;
          }
          response.setHeader(
            "Set-Cookie",
            sessionCookie(sessionValue(token), secure),
          );
          response.json({ required: true, signedIn: true });
        });
        return;
      }
    }
    // Liveness only: it says whether the server is up, nothing about the Runs.
    if (path === "/health" && request.method === "GET") return next();
    if (signedIn) {
      // A cookie is sent by the browser on its own, so a page on another port of
      // this host could make it send one. A write must say it is JSON, which a
      // plain HTML form cannot (a Bearer header is not sent on its own).
      const bearer = request.headers.authorization !== undefined;
      const read = request.method === "GET" || request.method === "HEAD";
      const json = /^application[/]json(?![a-z0-9])/i.test(
        request.headers["content-type"] ?? "",
      );
      if (!bearer && !read && !json) {
        response.status(415).json({ message: "Send JSON." });
        return;
      }
      return next();
    }
    response.status(401).json({ message: "Sign in with the access token." });
  };
}

function sessionCookie(
  value: string,
  secure: boolean,
  maxAgeSeconds = 7 * 86400,
) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
