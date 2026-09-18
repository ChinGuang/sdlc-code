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

## Measurements (live run, `results/probe-*.json`)

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
2. **Tab suspension.** When the Penpot tab is in the background, the browser throttles it and calls fail with `The Penpot plugin tab appears to be suspended by the browser (no heartbeat for ~40s). Please click/focus the Penpot tab…` (seen three times while designing the dashboard). Calls succeed again as soon as the tab is focused. The client retries on this error (2 s, 5 s, 10 s) and then raises `PenpotError(kind: "suspended")` with guidance for the Escalation screen.
3. **Plugin reloads lose state.** The plugin's `storage` object was wiped once mid-session (helpers had to be redefined). Agents must not rely on state across `execute_code` calls — send self-contained code each time.
4. **No file creation from the plugin API.** `penpot` exposes `createPage()` and `openPage()` but nothing to create or open a file. The agent can only work in the file the user has open with the plugin connected. **This conflicts with the agreed "one Penpot file per Run".**
5. **Useful extras for the UI Spec:** `penpot.generateStyle(shapes, { type: "css" })` and `generateMarkup` return CSS/HTML for a board, which can seed the Frontend Coding Agent's supplementary material.
6. **Board IDs are stable** and usable with `export_shape` directly.

## Recommendation for T10 (UI Design Agent)

- Use the tested `penpotClient.ts` as the starting point; keep code self-contained per call.
- Check connectivity at the start of the Design Phase (`execute_code: return penpot.currentFile?.name`) and escalate early if disconnected or suspended.
- Batch shape creation into a few large `execute_code` calls per screen (each call ~0.4 s overhead).
- Export PNGs once per screen after the design settles.
- **Decision needed:** replace "one Penpot file per Run" with "one **page** per Run inside a workspace file the user opens once" (see below).

## Open decision

> The plugin cannot create files. Options:
> - **(a) One page per Run** in a single "sdlc-code runs" file the user keeps open. Fully automatic via `createPage()`; the Design Gate links to the page.
> - **(b) One file per Run, created by the user** before the Design Phase (Run pauses until the plugin reports the new file). Matches the original decision but adds a manual step to every Run.
>
> Recommendation: (a).
