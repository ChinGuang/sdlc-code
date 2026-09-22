# Spike T01 — Nebius Token Factory Sandboxes from Node

- **Date:** 2026-09-18 (Early Access granted the same day; earlier calls were blocked)
- **Code:** spike code (removed from `main`; kept at commit [`e51a607`](https://github.com/ChinGuang/sdlc-code/tree/e51a607/spikes/t01-sandbox)) — `sandboxClient.ts`, `probe.ts` (live probe; `PROBE_ONLY=step1,step2` runs selected steps), `whoami.ts`. **Maintained code:** `packages/clients/src/sandbox` (`NebiusSandboxClient`, `commandSucceeded`, `whoAmI`); permission check: `pnpm --filter @sdlc-code/clients sandbox:whoami`
- **Result:** ✅ Everything a Test Run needs works from TypeScript over the REST API, and the **full ADR 0001 Test Run was exercised end to end**: branch the Base Snapshot, upload only the changed files, run unit tests + boot + smoke test in one disposable run — **0.8 s of execution, 1.5 s wall time**.
- **No Python SDK needed.** `contree-sdk` wraps the same documented REST API; our TypeScript client calls it directly.

All numbers below come from the probe's saved results (gitignored `results/`), mainly the full run `probe-1789718691886.json` (2026-09-18 08:01 UTC); the import time comes from the first run of the day and the polling rows from a rerun of that one step.

## Setup that worked

| Item | Value |
|---|---|
| API | `https://api.tokenfactory.nebius.com/sandboxes/v1` (ConTree REST API; OpenAPI spec in the docs) |
| Auth | `Authorization: Bearer <NEBIUS_API_KEY>` **and** `Project: <NEBIUS_AI_PROJECT>` |
| Access | **Early Access per project.** Before approval every call returned `403 Insufficient permissions`; `GET /whoami` lists each permission (`pnpm --filter @sdlc-code/clients sandbox:whoami`) |
| Limits (`/whoami`) | 3,600 s max per run · 50 concurrent runs · 12 GB writable layer · 8 concurrent imports · 3,600 s max import |
| Client | `NebiusSandboxClient implements SandboxClient` — `#private` token/project, arrow-method API (CODING_STANDARDS.md) |

## How the API works (what we rely on)

- `POST /files` (raw bytes) → file `uuid` (+ sha256).
- `POST /instances` `{ image, command, shell, files: { "/app/x": { uuid } }, timeout, disposable }` → operation `uuid`.
- `GET /operations/{id}` → poll to `SUCCESS` / `FAILED` / `CANCELLED`; the result carries exit code, stdout/stderr, timings, `cost`, and `result_image_uuid`.
- **Branching = starting a run from any earlier image.** A non-disposable run that changes files produces a new image; one that changes nothing returns its source image; `disposable: true` saves nothing.
- `POST /images/import` `{ registry: { url: "docker://…" }, tag }` imports a Docker image once; later runs use `tag:<name>` or the UUID.

## Measurements

| Step | What ran | Result | Execution / wall | `cost` |
|---|---|---|---|---|
| Node 22 image | import `docker.io/library/node:22-slim` as `sdlc-code/node:22-slim` | ✅ first run imported it (14.2 s wall incl. lookup); later runs found the tag (`imported: false`, 0.2 s) | — / 14.2 s once | — |
| Hello | `node -v && uname -a && nproc && free -m` | `v22.23.2`, Linux x86_64, **4 CPUs**; `free` missing → **exit 127** | 0.44 s / 1.0 s | 0.00019 |
| Network | `npm view express version` | ✅ `5.2.1` — outbound internet works | 1.37 s / 1.8 s | 0.0045 |
| Upload | 228-byte `server.cjs` | ✅ uuid + sha256 | — / 0.2 s | — |
| Smoke test | start server on :3000 in background, `fetch` `/health`, stop | ✅ `listening`, `smoke {"ok":true,"path":"/health"}` | 0.58 s / 2.0 s | 0.0009 |
| Processes between runs | run 1 starts server with `nohup` (not disposable); run 2 from its image fetches it | run 2: `not running`; files `server.cjs`, `server.log` present | 1.37 s + 0.53 s / 4.9 s | 0.0010 |
| Base Snapshot | `npm init && npm i express@4` (not disposable) | ✅ 67 packages, new image | 3.42 s / 5.5 s | **0.0173** |
| Branch A | from Base Snapshot: write `/app/branch.txt` | ✅ new image | 0.54 s / 2.2 s | 0.00007 |
| Branch B | from Base Snapshot: file absent, `node_modules` present | ✅ `isolated`, 67; **same image id as Base** (no changes) | 0.34 s / 1.7 s | 0.00008 |
| Branch A state | from Branch A's image: `cat /app/branch.txt` | ✅ `A` | 0.32 s / 1.7 s | 0.00006 |
| **End-to-end Test Run** | from Base Snapshot, disposable, 3 uploaded files; deps check → `node --test` (TAP) → boot → smoke → stop | ✅ `deps from Base Snapshot ok`, **2/2 tests pass**, smoke ok, exit 0 | **0.82 s / 1.5 s** (+0.7 s parallel uploads) | 0.0025 |
| Timeout | `sleep 30` with `timeout: 5` | ✅ killed: `timed_out: true`, exit **-1** | 5.32 s / 6.8 s | 0.00006 |
| **Long run** | 12 × `sleep 10; echo tick` with `timeout: 300` | ✅ all 12 ticks, exit 0 | **120.3 s** / 121.5 s | 0.00016 |
| Image catalogue | page through `GET /images` | **39,649 images**, public Node tags: `node:18-alpine`, `node:18-slim`, `node:20-alpine`, `node:20-slim` (no Node 22) | — / **227 s** | — |

**Polling overhead** (3 × `node -e 'console.log(1)'` per interval): server-side ~0.47–0.53 s; wall 2.3–2.4 s at 1,000 ms polling, 1.4–2.8 s at 250 ms, 0.9–1.2 s at 100 ms. Faster polling helps somewhat; the rest is platform queueing.

**Cost:** the `cost` field's unit is **not documented** (it looks like USD). It tracks **compute, not wall time**: a 120 s mostly-sleeping run cost 0.00016, while `npm install` (3.4 s of real work) cost 0.017 — about as much as 7 end-to-end Test Runs.

## Findings

1. ⚠️ **Operation `SUCCESS` does not mean the command succeeded.** `status` stays `SUCCESS` for exit 127, exit 3, and a command killed by the timeout (`timed_out: true`, exit -1). Pass/fail **must** come from `exit_code` and `timed_out` — use `commandSucceeded(result)` (tested).
2. ✅ **ADR 0001's Test Run works as designed** — Base Snapshot has the dependencies, only changed files are uploaded, one disposable run does unit tests + boot + smoke test, and nothing needs to survive between runs. No adjustment to the approach is needed.
3. **Processes do not survive between runs; files do.** A server started in one run was gone in the next, while its files remained in the resulting image. Smoke tests must start and stop the server within the same run (which works).
4. **Outbound network is on by default**, so `npm install` works inside the sandbox.
5. **Timeouts are enforced by the platform**, and long runs are fine: 120 s ran to completion; the documented cap is 3,600 s (not tested to the limit).
6. ⚠️ **Transient 504s happen.** One `POST /instances` hung for ~60 s and returned `504 Gateway Time-out` (nginx HTML); the next nine calls were fine. T13 must retry 5xx/timeouts on spawn and polling with backoff.
7. **Never list images without a `tag` filter** — the catalogue holds ~40k images and paging through it took 227 s. Look up our tag directly (as `nodeImage` does).
8. **Node 22 is not in the public catalogue**; importing `node:22-slim` once took ~14 s. Public `node:18/20` images exist if we ever need a fallback.

## Recommendation for T13 (Sandbox client + Test Runs)

- Build on `packages/clients/src/sandbox/sandboxClient.ts`; decide pass/fail with `commandSucceeded`, never `status` alone.
- Add **retry with backoff** for 5xx and network errors on `spawn`, `uploadFile` and `getOperation`.
- **Base Snapshot per Stack Profile:** import `node:22-slim` once, run the template's `npm ci` once (the expensive part), keep the image UUID and tag it with `set_image_tag` so it isn't cleaned up after 180 days (Beta retention).
- **Test Run** = one disposable run from the Base Snapshot with the changed files in `files` and one script: install new deps if the lockfile changed → unit tests with a machine-readable reporter (TAP worked) → boot → smoke → stop.
- Poll at ~250 ms (or use the SSE event stream); set `timeout` per Test Run (e.g. 600 s).
- Upload files in parallel (3 uploads took 0.7 s) and skip re-uploading unchanged files by sha256.

### What T13 built, and where it differs

Code: `packages/core/src/testRuns` (`SandboxBaseSnapshots`, `SandboxTestRunner`); live check: `NEBIUS_LIVE=1 pnpm --filter @sdlc-code/core test testRuns.live`.

- **No `set_image_tag`.** It is a permission name in `/whoami`, but the REST path to tag an image is not documented, so we do not guess one. The Base Snapshot's image UUID is kept in our SQLite database (`base_snapshots`, keyed by profile and a hash of the template files, the build command and the base image). It is rebuilt after 150 days, before the 180-day retention can drop it, and when a Test Run is refused with 404/410. *Assumption, not yet seen live:* an expired image is reported as 404/410 on spawn.
- **Install only when the manifest changes.** The template's test script stamps `node_modules` with a hash of `package.json` + `package-lock.json`; a Slice that adds a dependency triggers `npm install`, anything else reuses the Snapshot's.
- **Per-run timeout 1,800 s, not 600 s,** so the script's own step limits (worst case ~1,600 s) always fire first and it still prints its result; the log goes to a file and only its last 60 kB is printed, so the `SDLC_RESULT` line survives any output truncation.
- **Secrets:** `.env` files (not `.env.example`) are never uploaded, for Snapshots or Test Runs.
- **Measured (2026-09-22):** cold (import check + Snapshot build + two Test Runs) 62 s; warm Test Run of the template ~13 s, of a Slice with one failing test ~7 s. Node 22 slim has no OpenSSL; Prisma warns and falls back to openssl-1.1.x, which works.

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

`GET /operations/{id}` for `echo hello; exit 3` (disposable) — `"status": "SUCCESS"` with `"exit_code": 3`:

```json
{
  "uuid": "01a0b388-c416-70d6-887a-1d2b222e1c51",
  "kind": "instance",
  "status": "SUCCESS",
  "error": null,
  "created_at": "2026-09-18T08:01:19.911863+00:00",
  "duration": 0.334,
  "consumed_cpu": 0.001183,
  "consumed_memory": 7836,
  "image_uuid": "40cebcb4-047a-3871-a10b-4b529e70ef29",
  "result_image_uuid": null,
  "metadata": {
    "command": "echo hello; exit 3",
    "shell": true,
    "disposable": true,
    "networking": { "enabled": true },
    "timeout": 30,
    "result": {
      "resources": { "cost": 0.00005101 },
      "state": { "exit_code": 3, "pid": 7, "signal": -1, "timed_out": false },
      "stdout": { "value": "hello\n", "encoding": "ascii", "truncated": false }
    }
  }
}
```

(Trimmed to the relevant fields; the full response also lists resource counters and default metadata such as `uid`, `gid`, `cwd`, `env`, `stdin`.)

End-to-end Test Run stdout:

```text
deps from Base Snapshot ok
TAP version 13
# Subtest: sum adds
ok 1 - sum adds
# Subtest: sum with zero
ok 2 - sum with zero
1..2
# tests 2
# pass 2
# fail 0
listening
smoke {"ok":true,"path":"/health"}
```

(TAP detail lines such as `duration_ms` removed.)

Processes-between-runs, run 2 stdout: `not running` / `files: server.cjs server.log`.

Transient error on `POST /instances` (once, after ~60 s):

```text
Sandbox API POST /instances failed: 504 <html><head><title>504 Gateway Time-out</title></head> … nginx …
```
