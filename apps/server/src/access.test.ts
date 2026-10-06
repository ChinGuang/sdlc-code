// SPDX-License-Identifier: MPL-2.0
/**
 * Who may use the server (S2): the settings that refuse an open server on the
 * network, the sign-in over HTTP, and the dashboard served beside the API.
 */
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  accessSettings,
  AccessConfigError,
  sameToken,
  sessionValue,
  SESSION_COOKIE,
} from "./access.js";
import { AppModule } from "./app.module.js";
import { configureApp, HOST } from "./configureApp.js";
import {
  RUN_LIFECYCLE,
  RUN_SERVICE,
  type RunLifecycle,
  type RunService,
} from "./runs/runService.js";
import { fileFor, stripApiPrefix } from "./staticWeb.js";

const TOKEN = "a-long-enough-access-token";

describe("accessSettings", () => {
  it("is loopback with no token by default", () => {
    expect(accessSettings({})).toEqual({ host: "127.0.0.1", token: null });
  });

  it("refuses the network with no token", () => {
    expect(() => accessSettings({ SDLC_CODE_HOST: "0.0.0.0" })).toThrow(
      AccessConfigError,
    );
    expect(() => accessSettings({ SDLC_CODE_HOST: "0.0.0.0" })).toThrow(
      /SDLC_ACCESS_TOKEN/,
    );
  });

  it("allows the network with a token", () => {
    expect(
      accessSettings({ SDLC_CODE_HOST: "0.0.0.0", SDLC_ACCESS_TOKEN: TOKEN }),
    ).toEqual({ host: "0.0.0.0", token: TOKEN });
  });

  it("refuses a token too short to resist guessing, even on loopback", () => {
    expect(() => accessSettings({ SDLC_ACCESS_TOKEN: "short" })).toThrow(
      /at least 16/,
    );
  });
});

describe("sameToken", () => {
  it("compares whole tokens", () => {
    expect(sameToken(TOKEN, TOKEN)).toBe(true);
    expect(sameToken(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(sameToken("", TOKEN)).toBe(false);
  });
});

describe("stripApiPrefix and fileFor", () => {
  it("strips /api, and only /api", () => {
    expect(stripApiPrefix("/api/runs?x=1")).toBe("/runs?x=1");
    expect(stripApiPrefix("/api")).toBe("/");
    expect(stripApiPrefix("/apiary")).toBeNull();
    expect(stripApiPrefix("/runs")).toBeNull();
  });

  it("names files inside the build and none outside it", () => {
    const root = mkdtempSync(join(tmpdir(), "web-"));
    try {
      writeFileSync(join(root, "a.js"), "x");
      expect(fileFor(root, "/a.js")).toBe(join(root, "a.js"));
      expect(fileFor(root, "/missing.js")).toBeNull();
      expect(fileFor(root, "/../etc/passwd")).toBeNull();
      expect(fileFor(root, "/%2e%2e/secret")).toBeNull();
      expect(fileFor(root, "/%zz")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const apps: INestApplication[] = [];
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

const idle: RunLifecycle = {
  resumeUnfinished: async () => ({ resumed: [], failed: [] }),
  shutdown: async () => {},
};
const service = { listRuns: () => [] } as unknown as RunService;

async function start(
  options: Parameters<typeof configureApp>[1],
): Promise<string> {
  const app = (
    await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RUN_SERVICE)
      .useValue(service)
      .overrideProvider(RUN_LIFECYCLE)
      .useValue(idle)
      .compile()
  ).createNestApplication({ logger: false });
  configureApp(app, options);
  apps.push(app);
  await app.listen(0, HOST);
  return app.getUrl();
}

describe("a server with an access token", () => {
  it("turns away a request with no token, but answers /health", async () => {
    const url = await start({ accessToken: TOKEN });

    expect((await fetch(`${url}/runs`)).status).toBe(401);
    expect((await fetch(`${url}/runs/abc/events`)).status).toBe(401);
    expect((await fetch(`${url}/health`)).status).not.toBe(401);
  });

  it("takes the token as a Bearer header, and no other token", async () => {
    const url = await start({ accessToken: TOKEN });

    const good = await fetch(`${url}/runs`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const bad = await fetch(`${url}/runs`, {
      headers: { authorization: "Bearer not-the-token-at-all" },
    });

    expect(good.status).toBe(200);
    expect(bad.status).toBe(401);
  });

  it("signs a person in with the token, by a cookie scripts cannot read", async () => {
    const url = await start({ accessToken: TOKEN });

    const before = await fetch(`${url}/session`);
    const wrong = await fetch(`${url}/session`, {
      method: "POST",
      body: JSON.stringify({ token: "wrong-wrong-wrong-wrong" }),
    });
    const signIn = await fetch(`${url}/session`, {
      method: "POST",
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookie = signIn.headers.get("set-cookie") ?? "";
    const after = await fetch(`${url}/runs`, {
      headers: { cookie: cookie.split(";")[0]! },
    });

    expect(await before.json()).toEqual({ required: true, signedIn: false });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(signIn.status).toBe(200);
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toMatch(/Secure/);
    expect(after.status).toBe(200);
    // What the browser keeps is not the token, and is no Bearer token either.
    expect(cookie).not.toContain(TOKEN);
    expect(cookie).toContain(sessionValue(TOKEN));
    const asBearer = await fetch(`${url}/runs`, {
      headers: { authorization: `Bearer ${sessionValue(TOKEN)}` },
    });
    expect(asBearer.status).toBe(401);
  });

  it("marks the cookie Secure when the page is served over https", async () => {
    const url = await start({ accessToken: TOKEN, secureCookie: true });

    const signIn = await fetch(`${url}/session`, {
      method: "POST",
      body: JSON.stringify({ token: TOKEN }),
    });

    expect(signIn.headers.get("set-cookie")).toMatch(/Secure/);
  });

  it("signs out by clearing the cookie", async () => {
    const url = await start({ accessToken: TOKEN });

    const out = await fetch(`${url}/session`, { method: "DELETE" });

    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("takes a malformed cookie for no sign-in, not for a server error", async () => {
    const url = await start({ accessToken: TOKEN });
    const bad = { cookie: `${SESSION_COOKIE}=%` };

    expect((await fetch(`${url}/runs`, { headers: bad })).status).toBe(401);
    expect((await fetch(`${url}/health`, { headers: bad })).status).not.toBe(
      500,
    );
    expect((await fetch(`${url}/session`, { headers: bad })).status).toBe(200);
  });

  it("answers a sign-in whose body is too long, instead of hanging", async () => {
    const url = await start({ accessToken: TOKEN });

    const sent = await fetch(`${url}/session`, {
      method: "POST",
      body: JSON.stringify({ token: "x".repeat(10_000) }),
      signal: AbortSignal.timeout(5000),
    }).then(
      (response) => response.status,
      // A server that cut the connection has answered, too: it did not hang.
      (error: Error) => (error.name === "TimeoutError" ? "hung" : "closed"),
    );

    expect(sent).not.toBe("hung");
  });

  it("refuses a write the browser could have been made to send on its own", async () => {
    const url = await start({ accessToken: TOKEN });
    const cookie = (
      await fetch(`${url}/session`, {
        method: "POST",
        body: JSON.stringify({ token: TOKEN }),
      })
    ).headers
      .get("set-cookie")!
      .split(";")[0]!;

    const form = await fetch(`${url}/runs`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "projectRequest=x",
    });
    const json = await fetch(`${url}/runs`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    const bearer = await fetch(`${url}/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "{}",
    });

    expect(form.status).toBe(415);
    expect(json.status).not.toBe(415);
    expect(bearer.status).not.toBe(415);
  });

  it("does not take a token in the query string", async () => {
    const url = await start({ accessToken: TOKEN });

    expect((await fetch(`${url}/runs?token=${TOKEN}`)).status).toBe(401);
  });
});

describe("a server with no access token", () => {
  it("asks nobody for anything", async () => {
    const url = await start({});

    expect((await fetch(`${url}/runs`)).status).toBe(200);
  });
});

describe("a server that serves the dashboard", () => {
  function build() {
    const root = mkdtempSync(join(tmpdir(), "web-"));
    folders.push(root);
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<html>dashboard</html>");
    writeFileSync(join(root, "assets", "app-1.js"), "console.log(1)");
    return root;
  }

  it("finds its files whether the folder is given with a trailing slash or not", async () => {
    const root = build();
    const url = await start({ webDir: `${root}/` });

    expect(await (await fetch(`${url}/assets/app-1.js`)).text()).toBe(
      "console.log(1)",
    );
  });

  it("says a missing file is missing, and a route of the app is the page", async () => {
    const url = await start({ webDir: build() });

    expect((await fetch(`${url}/assets/nope.js`)).status).toBe(404);
    expect(await (await fetch(`${url}/runs/abc`)).text()).toContain(
      "dashboard",
    );
  });

  it("serves the page, its files, and the page again for a route of the app", async () => {
    const url = await start({ webDir: build() });

    const page = await fetch(`${url}/runs/abc`);
    const file = await fetch(`${url}/assets/app-1.js`);

    expect(await page.text()).toBe("<html>dashboard</html>");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await file.text()).toBe("console.log(1)");
    expect(file.headers.get("content-type")).toMatch(/javascript/);
    expect(file.headers.get("cache-control")).toMatch(/immutable/);
  });

  it("answers the API under /api, with the prefix stripped, behind the token", async () => {
    const url = await start({ webDir: build(), accessToken: TOKEN });

    const signedOut = await fetch(`${url}/api/runs`);
    const signedIn = await fetch(`${url}/api/runs`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // The dashboard's own files need no sign-in: they hold no secret.
    const page = await fetch(`${url}/`);

    expect(signedOut.status).toBe(401);
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toEqual([]);
    expect(page.status).toBe(200);
  });
});
