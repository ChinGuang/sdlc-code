# Spike T01 — Nebius Token Factory Sandboxes from Node

- **Date:** 2026-09-18 (access granted the same day; blocked earlier by Early Access permissions)
- **Code:** [`spikes/t01-sandbox`](../../spikes/t01-sandbox) — `sandboxClient.ts` (tested `NebiusSandboxClient`), `probe.ts` (live probe), `followup.ts` (public images, polling), `whoami.ts` (permission check)
- **Result:** ✅ Everything Test Runs need works from TypeScript over the REST API: run commands, upload files, outbound network, a server + smoke test inside one run, saved images to branch from, enforced timeouts. Runs are fast (~0.3–3.5 s of execution, ~1–2 s total) and cheap.
- **No Python SDK needed.** `contree-sdk` is a convenience wrapper over the same documented REST API; our TypeScript client calls it directly.

## Setup that worked

| Item | Value |
|---|---|
| API | `https://api.tokenfactory.nebius.com/sandboxes/v1` (ConTree REST API, OpenAPI spec in the docs) |
| Auth | `Authorization: Bearer <NEBIUS_API_KEY>` **and** `Project: <NEBIUS_AI_PROJECT>` header |
| Access | Sandboxes is **Early Access** per project. Before approval every call returned `403 Insufficient permissions`; `GET /whoami` shows each permission (`pnpm whoami`) |
| Limits (`/whoami`) | 3,600 s max per run · 50 concurrent runs · 12 GB writable layer · 8 concurrent image imports |
| Client | `NebiusSandboxClient implements SandboxClient` — `#private` token/project, arrow-method API (CODING_STANDARDS.md) |

## How the API works (what we rely on)

- `POST /files` (raw bytes) → file `uuid`.
- `POST /instances` `{ image, command, shell, files: { "/app/x": { uuid } }, timeout, disposable }` → operation `uuid`.
- `GET /operations/{id}` → poll to `SUCCESS` / `FAILED` / `CANCELLED`; the result has exit code, stdout/stderr, timings, cost, and `result_image_uuid`.
- **Branching = starting a run from any earlier image.** A non-disposable run that changes files produces a new image; a run that changes nothing returns its source image; `disposable: true` saves nothing.
- `POST /images/import` `{ registry: { url: "docker://…" }, tag }` imports a Docker image once; later runs use `tag:<name>` or the image UUID.

## Measurements (live run, 2026-09-18)

| Step | What ran | Result | Execution / wall | Cost (API `cost`) |
|---|---|---|---|---|
| List images | `GET /images` | 100 images visible | — / 0.8 s | — |
| Import Node 22 | `docker.io/library/node:22-slim` as `sdlc-code/node:22-slim` | ✅ one-off | — / **14.2 s** | — |
| Hello | `node -v && uname -a && nproc && free -m` | `v22.23.2`, Linux x86_64, **4 CPUs**; `free` missing → **exit 127** | 0.45 s / 1.0 s | 0.00019 |
| Network | `npm view express version` | ✅ `5.2.1` — outbound internet works | 1.3 s / 2.2 s | 0.0043 |
| Upload | 228-byte `server.cjs` | ✅ uuid + sha256 | — / 0.4 s | — |
| **Smoke test** | start `server.cjs` on :3000 in background, `fetch` `/health`, stop | ✅ `listening`, `smoke {"ok":true,"path":"/health"}` | 0.58 s / 1.8 s | 0.00096 |
| **Base Snapshot** | `npm init && npm i express@4` (not disposable) | ✅ 67 packages, new image | 3.4 s / 5.5 s | 0.0177 |
| Branch A | from Base Snapshot: write `/app/branch.txt` | ✅ new image | 0.46 s / 2.2 s | 0.00007 |
| Branch B | from Base Snapshot: check file absent, `node_modules` present | ✅ `isolated`, 67 packages; **same image id as Base** (no changes) | 0.35 s / 1.7 s | 0.00008 |
| Branch A state | from Branch A's image: `cat /app/branch.txt` | ✅ `A` | 0.35 s / 1.8 s | 0.00007 |
| **Timeout** | `sleep 30` with `timeout: 5` | ✅ killed: `timed_out: true`, exit **-1** | 5.3 s / 6.8 s | 0.00006 |

Polling overhead (`pnpm followup`, 3 runs each of `node -e 'console.log(1)'`): server-side duration ~0.5 s; wall time 0.8–3.1 s whether polling every 1,000, 250 or 100 ms, so most of the gap is platform queueing, not our poll interval.

The `cost` field's unit is **not documented** (it looks like USD). The only notable cost was `npm install` (~0.018 per install) — a strong reason to install dependencies **once** into a Base Snapshot.

## Findings

1. ⚠️ **Operation `SUCCESS` does not mean the command succeeded.** `status` is `SUCCESS` for exit code 127 (`free: not found`), for exit code 3, and for a command killed by the timeout (`timed_out: true`, exit -1). Test pass/fail **must** come from `exit_code` and `timed_out`. The client now exports a tested `commandSucceeded(result)` helper for this.
2. **The Base Snapshot plan in ADR 0001 works as designed.** Install dependencies once (non-disposable run) → keep its `result_image_uuid` → every Test Run starts from it (`disposable: true`), uploads only changed files via `files`, and runs the test script. Branches from the same image are isolated from each other.
3. **Smoke tests work inside a single run**: start the server in the background, request it on `127.0.0.1`, stop it. No need for ports to survive between runs (they don't: running processes are not kept).
4. **Outbound network is on by default** (`networking.enabled: true`), so `npm install` works in the sandbox.
5. **Images:** Nebius hosts public `node:18-*` and `node:20-*` (plus many Python images) but no Node 22 — we import `node:22-slim` once (14 s) under our own tag. `GET /images` returns 100 per page by default, so the list may be truncated.
6. **Timeouts are enforced by the platform** (`timeout` in seconds, max 3,600). Our own wait timeout in `waitForOperation` is a second safety net.
7. **Fast enough for the loop:** simple runs finish in ~1–2 s wall time; `npm install` of a small app ~3.5 s of execution.

## Recommendation for T13 (Sandbox client + Test Runs)

- Start from `spikes/t01-sandbox/src/sandboxClient.ts`; decide success with `commandSucceeded`, never `status` alone.
- **Base Snapshot per Stack Profile:** import `node:22-slim` once, run the template's `npm ci` once, store the resulting image UUID (tag it with `set_image_tag` so it isn't cleaned up after 180 days).
- **Test Run** = `POST /instances` from the Base Snapshot, `disposable: true`, changed files via `files`, one script that installs any new deps, runs unit tests, boots the server, runs smoke tests and stops it, and prints machine-readable results.
- Poll at ~250 ms (or use the SSE event stream later); set `timeout` per Test Run (e.g. 600 s).
- Upload files in parallel and reuse uploads by sha256 (`GET /files` can check existence) to keep Test Runs fast.

## Appendix: what the real server returned

`GET /whoami` permissions before and after Early Access approval (limits identical):

```json
{ "import": false, "spawn": false, "spawn_disposable": false, "list": false, "cancel": false, "set_image_tag": false }
{ "import": true,  "spawn": true,  "spawn_disposable": true,  "list": true,  "cancel": true,  "set_image_tag": true }
```

Error before approval:

```text
Sandbox API POST /instances failed: 403 Insufficient permissions: spawn or spawn_disposable
```

`GET /operations/{id}` for `echo hello; exit 3` (disposable) — note `"status": "SUCCESS"` with `"exit_code": 3`:

```json
{
  "uuid": "01a0b37f-d9bc-7456-bb5c-2d941c792e41",
  "kind": "instance",
  "status": "SUCCESS",
  "error": null,
  "created_at": "2026-09-18T07:51:35.625570+00:00",
  "duration": 0.334,
  "consumed_cpu": 0.001257,
  "consumed_memory": 9880,
  "image_uuid": "40cebcb4-047a-3871-a10b-4b529e70ef29",
  "result_image_uuid": null,
  "metadata": {
    "command": "echo hello; exit 3",
    "shell": true,
    "cwd": "/",
    "disposable": true,
    "networking": { "enabled": true },
    "timeout": 30,
    "files": {},
    "result": {
      "resources": { "cost": 0.00006197, "elapsed_time": 0.001257, "max_rss": 9880 },
      "state": { "exit_code": 3, "pid": 7, "signal": -1, "timed_out": false },
      "stdout": { "value": "hello\n", "encoding": "ascii", "truncated": false },
      "stderr": { "value": "", "encoding": "ascii", "truncated": false }
    }
  }
}
```

(Trimmed: zero-valued resource counters and default metadata fields such as `uid`, `gid`, `env`, `stdin`, `hostname`.)

Smoke test stdout (server started, requested and stopped inside one run):

```text
listening
smoke {"ok":true,"path":"/health"}
```

Timeout run (`sleep 30`, `timeout: 5`): `status: SUCCESS`, `exit_code: -1`, `timed_out: true`, duration 5.343 s.
