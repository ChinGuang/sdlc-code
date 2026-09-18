# Spike T02 — Penpot MCP from a Node MCP client

- **Date:** 2026-09-18
- **Code:** [`spikes/t02-penpot-mcp`](../../spikes/t02-penpot-mcp) — `penpotClient.ts` (tested wrapper), `probe.ts` (live probe)
- **Result:** ✅ Works end to end. Node → Penpot Cloud MCP → Penpot plugin in the browser → shapes created, exported to PNG, removed.

## Setup that worked

| Item | Value |
|---|---|
| MCP endpoint | Penpot Cloud hosts it: `https://design.penpot.app/mcp/stream?userToken=…` (Streamable HTTP) |
| Client | `@modelcontextprotocol/sdk` 1.30 `Client` + `StreamableHTTPClientTransport` |
| Config | `PENPOT_MCP_URL` in `.env` — **contains a user token; never log it** |
| Prerequisite | Penpot file open in a browser tab with the MCP plugin connected |
| Server | `penpot` v1.0.0, tools: `execute_code`, `export_shape`, `high_level_overview`, `penpot_api_info` |

The MCP server is remote, but every tool call is executed by the plugin running in the user's browser tab. Our server can run anywhere; the browser tab is the hard dependency.

## Measurements (live run, `results/probe-1789694967160.json`)

| Step | Time |
|---|---|
| Connect | ~0.6 s |
| `execute_code` round-trip (trivial) | ~380 ms median (5 samples: 381, 385, 570, 389, 384) |
| Create board + text | 0.6–1.0 s |
| `export_shape` PNG (480×200) | **~7 s** |
| `generateStyle` CSS for a board | ~2.6 s |
| Remove shape | ~2.7 s |

Implication: a 5-screen design with ~40 calls per screen is minutes, not seconds. Exports are the slow part — export once per screen at the end, not after every change.

## Findings

1. **Failures are not flagged with `isError`.** A failing `execute_code` returns normal content with text `Tool execution failed: Error: Error handling task: <message>`. A client that only checks `isError` treats broken design steps as success. `penpotClient.ts` detects the prefix (covered by tests).
2. **Tab suspension (observed, not yet measured).** When the Penpot tab is in the background, the browser throttles it and calls fail with `Tool execution failed: … The Penpot plugin tab appears to be suspended by the browser (no heartbeat for 39–45s). Please click/focus the Penpot tab…`. This happened three times while designing the dashboard on 2026-09-17; each time the next call succeeded right after the tab was focused. **Not measured by this probe:** whether an in-flight call blocks until the heartbeat timeout or fails immediately, how long recovery takes, and whether a call that failed this way had already partly executed. Backgrounding a tab cannot be automated from the probe — T10 must measure these manually.
   - **Recovery needs a human.** The client's retries (2 s, 5 s, 10 s ≈ 17 s total) only bridge a brief refocus; they will not recover a tab the user has left. After the schedule it raises `PenpotError(kind: "suspended")` with guidance, which should become an Escalation ("Focus the Penpot tab").
   - Because a failed call may have partly run, design code must be **idempotent** (e.g. find-or-create boards by name) before retrying.
   - `disconnected` (no plugin connected) is not retried — it escalates immediately.
3. **Plugin reloads lose state.** The plugin's `storage` object was wiped once mid-session (helpers had to be redefined). Agents must not rely on state across `execute_code` calls — send self-contained code each time.
4. **No file creation from the plugin API.** `penpot` exposes `createPage()` and `openPage()` but nothing to create or open a file. The agent can only work in the file the user has open with the plugin connected. **This conflicts with the agreed "one Penpot file per Run".**
5. **CSS export works:** `penpot.generateStyle(shapes, { type: "css" })` returned CSS for the board (~2.6 s). `generateMarkup` (HTML/SVG) exists in the API but was not exercised. Could seed the Frontend Coding Agent's supplementary material.
6. **Board IDs returned by `execute_code` work directly with `export_shape`** within a session. Stability across plugin reloads was not tested.
7. **Non-JSON success output is rejected** by the client rather than passed through, so a proxy/gateway error page cannot masquerade as a result.
8. **Token hygiene:** `PENPOT_MCP_URL` embeds a user token. The client and probe redact `userToken=…` from every error message and stored result (`redactToken`, tested). New probe result files are gitignored.

## Recommendation for T10 (UI Design Agent)

- Use the tested `penpotClient.ts` as the starting point; keep code self-contained per call.
- Check connectivity at the start of the Design Phase (`execute_code: return penpot.currentFile?.name`) and escalate early if disconnected or suspended.
- Batch shape creation into a few large `execute_code` calls per screen (each call ~0.4 s overhead).
- Export PNGs once per screen after the design settles.
- **Decision needed** before T10 (see below).

## Open decision

> Finding 4 conflicts with the agreed "one Penpot file per Run". This spike does not change the design; the decision goes to the product owner and, once made, into CONTEXT.md / an ADR. Options:
> - **(a) One page per Run** in a single "sdlc-code runs" file the user keeps open. Fully automatic via `createPage()`; the Design Gate links to the page.
> - **(b) One file per Run, created by the user** before the Design Phase (Run pauses until the plugin reports the new file). Matches the original decision but adds a manual step to every Run.
>
> Recommendation: (a).
