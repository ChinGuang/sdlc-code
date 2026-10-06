# Self-hosted Penpot (S4)

By default the UI Design Agent draws in **Penpot Cloud** (`design.penpot.app`) through its hosted MCP server. This runs Penpot on your own machine instead, with Docker Compose: the designs stay on your disk, and nothing about a Run's screens leaves it. sdlc-code does not care which: only `PENPOT_MCP_URL` changes.

> **Verified, and not.** On a laptop with Docker, the stack was started from the files below and the following was checked: every service starts, the web UI answers on `http://127.0.0.1:9001` (and only there), the backend answers through it, the MCP server answers at `/mcp/stream`, and **sdlc-code's own Penpot client connects to it over plain HTTP and lists the same four tools as Penpot Cloud** (`execute_code`, `high_level_overview`, `penpot_api_info`, `export_shape`). **Not verified:** creating the MCP key in the UI, connecting the plugin in a browser tab, and drawing a UI Spec on a self-hosted instance, because those need an account and a person at the browser. Do `penpot:smoke` (below) before trusting it with a Run.

## What is here

`deploy/penpot/`:

| File | What |
|---|---|
| `docker-compose.yaml` | **Penpot's own compose file, unchanged** (version 2.18, from [penpot/penpot](https://github.com/penpot/penpot/blob/main/docker/images/docker-compose.yaml), MPL-2.0). It runs the frontend, backend, exporter, admin console, **MCP server**, Postgres, Valkey and a mail catcher. |
| `docker-compose.override.yaml` | What Compose adds on top of it by itself, from the same folder: the web UI (9001) and the mail catcher (1080) listen on `127.0.0.1` only; the secret key and the database password come from `.env`; Penpot's telemetry is off. |
| `penpot.env.example` | The three values to set. |

Keeping Penpot's file as it is means an upgrade is a diff against upstream, not a merge.

## Start it

```bash
cd deploy/penpot
cp penpot.env.example .env
# put a long random value after each = : openssl rand -base64 48   and   openssl rand -hex 24
docker compose up -d
```

The first start pulls about eight images. Open <http://localhost:9001>, create an account (there is no e-mail check on this setup; the mail catcher at <http://localhost:1080> shows any mail Penpot sends), and make a file.

## Point sdlc-code at it

1. In Penpot: your account settings, and create a personal **MCP key** ([Penpot's MCP guide](https://help.penpot.app/mcp/) says where). Treat it like a password.
2. In sdlc-code's `.env`:

   ```text
   PENPOT_MCP_URL=http://localhost:9001/mcp/stream?userToken=<the key>
   ```

   The URL holds the key, so it is never logged, and the script that prints a Run's Penpot link takes the host from this URL (`PENPOT_ORIGIN` overrides it).
3. Open your Penpot file in the browser and enable the **MCP plugin** in it, as the same guide describes for Penpot Cloud. Keep that tab open while a Run designs: the plugin runs the drawing commands, and the server cannot do without it.
4. Restart the sdlc-code server, then:

   ```bash
   pnpm --filter @sdlc-code/core penpot:smoke    # draws a fixed UI Spec and exports PNGs
   ```

## Keep or throw away

```bash
docker compose down        # stop; designs and accounts stay in the volumes
docker compose down -v     # stop and delete every design and account
```

## Beyond this machine

The override is for a Penpot you reach on the machine it runs on. Putting it on a network is a different job, and Penpot's own file says why: **remove `disable-secure-session-cookies` and `disable-email-verification`** from its flags, serve it over HTTPS (it suggests Traefik, with the labels already in the file), set `PENPOT_PUBLIC_URI` to the real address, configure a real SMTP service, and turn off open registration. None of that was tried here. If sdlc-code runs in the container from [deploy.md](deploy.md) and Penpot on the same host, the server reaches Penpot's MCP at the address in `PENPOT_MCP_URL`, but your browser tab (the plugin) must reach the same Penpot.
