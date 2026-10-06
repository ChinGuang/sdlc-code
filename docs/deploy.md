# Running sdlc-code on a server (S2)

sdlc-code is a single developer's tool that holds API keys and spends money. By default it listens on `127.0.0.1` and asks nobody for anything. To put it on a machine you reach over a network (a Nebius AI Cloud VM, any VM, a home server), run the container below. It then listens on the network, and every request needs an **access token**.

> **Verified, and not.** The image was built and run with Docker on a laptop, and the sign-in, the token on every route (including the event stream) and the health check were exercised over HTTP. **Nothing was deployed to Nebius AI Cloud or any other cloud**: the cloud steps below are the shape of it, not a tested recipe. Treat the first deployment as a test.

> **Use HTTPS.** The image listens on plain HTTP. Without TLS the token and the session cookie cross the network in clear text. Put a TLS-terminating proxy or load balancer in front, and set `SDLC_SECURE_COOKIE=1`.

## What this is, and is not

- **One user.** The access token is one shared secret. There are no accounts, no per-user keys (BYOK) and no per-user Runs: whoever holds the token can start Runs, spend your tokens and credit, and push to every repository your `GITHUB_TOKEN` can reach. Do not hand it to anyone you would not hand those keys to.
- **Not for the open internet without TLS.** The token travels in a header or a cookie. Put the container behind HTTPS (a reverse proxy such as Caddy or nginx, or the cloud's load balancer) and set `SDLC_SECURE_COOKIE=1` so the cookie is marked `Secure`.
- **Penpot still needs a browser tab.** The UI Design Agent drives Penpot through a plugin in a browser tab of *yours* (the Penpot spike explains why). A server in a data centre does not change that: keep a tab open on the Penpot file while a Run designs.

## Build and run

```bash
docker build -t sdlc-code .

docker run -d --name sdlc-code --restart unless-stopped \
  -p 4317:4317 \
  -v sdlc-data:/data \
  -e SDLC_ACCESS_TOKEN="$(openssl rand -hex 24)" \
  -e NEBIUS_API_KEY=... -e NEBIUS_AI_PROJECT=... \
  -e PENPOT_MCP_URL=... \
  -e GITHUB_TOKEN=... \
  sdlc-code
```

Write the generated token down: it is the only way in. Open `http://<host>:4317` (or your HTTPS address), paste it into the sign-in form, and the dashboard works as it does locally. The command line reaches the same server with `SDLC_API_URL=https://<host>/api` and `SDLC_ACCESS_TOKEN=<the token>`, which it sends as a Bearer header on every call and on the event stream.

| Variable | Meaning |
|---|---|
| `SDLC_ACCESS_TOKEN` | **Required in the image.** At least 16 characters. The server refuses to start on a network address without it. |
| `SDLC_CODE_HOST` | The address to listen on. The image sets `0.0.0.0`. Left unset outside the image it is `127.0.0.1`, which needs no token. |
| `SDLC_CODE_PORT` | Default `4317`. |
| `SDLC_SECURE_COOKIE` | `1` when you serve it over HTTPS. |
| `SDLC_DATA_DIR` | Where Runs are kept. The image sets `/data`: mount a volume there or Runs are lost with the container. |
| `SDLC_WEB_DIR` | The built dashboard to serve. The image sets it; the API then answers under `/api`. |
| the keys | `NEBIUS_API_KEY`, `NEBIUS_AI_PROJECT`, `PENPOT_MCP_URL`, `GITHUB_TOKEN`, as in the README. Pass them as environment variables or your platform's secret store; they are never in the image. |

## How the server protects itself

- **No open network server.** `SDLC_CODE_HOST` other than `127.0.0.1` without `SDLC_ACCESS_TOKEN` stops the server at startup, with a message that says why.
- **Every route but `/health` needs the token**: the API, the screenshots, and the event stream. The token goes in an `Authorization: Bearer` header, never in the query string (a URL ends up in logs).
- **The dashboard signs in once** (`POST /session`). The browser then keeps a cookie that is `HttpOnly` (scripts cannot read it), `SameSite=Strict`, and a value derived from the token, not the token. It is still a way in until it expires after seven days, or until `DELETE /session`: treat a shared computer accordingly.
- **Tokens are compared in constant time**, and a token under 16 characters is refused.
- **The image holds no secrets.** `.dockerignore` keeps every `.env` file, the local Runs and the local config out; the process runs as a non-root user (uid 10001); Runs are in the `/data` volume.

- **Writes under a cookie must say they are JSON** (`415` otherwise), so a plain HTML form on another port of the same host cannot make the browser start a Run (`SameSite=Strict` ignores ports). A Bearer header is not sent on its own, so it is exempt.
- **A rejected request mid-session** (the cookie expired, the token changed) returns the dashboard to the sign-in form; any failure of `GET /session` other than a missing route asks for the token too.
- **Bind mounts:** `/data` is owned by uid 10001 in the image. A named volume inherits that; a host folder you mount must be `chown`ed to 10001, or the server cannot write its Runs.

Not done: a revocable session (the cookie is a fixed value derived from the token, so it works until the token changes, whatever its `Max-Age`; change the token to sign every browser out), an entropy check on the token (generate it with `openssl rand -hex 24`), rate-limiting failed sign-ins (the token is long and random, but a public address will be probed; put the container behind a proxy that limits requests), rotating the token without a restart, per-user accounts, and an audit log of who started what.

## On Nebius AI Cloud (not tested)

What would be needed, in outline: a small VM (2 vCPU, 4 GB is enough for the server; the sandboxes run in Token Factory, not here), Docker on it, the `docker run` above with the keys from the cloud's secret store, a persistent disk for `/data`, and an HTTPS front (a reverse proxy on the VM or a load balancer) in front of port 4317, with the firewall open to 443 only. Check Nebius's documentation for the current commands and prices; they were not looked up for this note.

## Build check

`docker build` is not part of CI yet. To check the image after a change: build it, run it with a token, and see `GET /api/session` answer `{"required":true,"signedIn":false}`, `GET /api/runs` answer 401 without the token, and the container's health status turn `healthy`.
