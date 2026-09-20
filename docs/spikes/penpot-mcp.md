# Spike T02 — Penpot MCP from a Node MCP client

- **Date:** 2026-09-18
- **Code:** spike code (removed from `main`; kept at commit [`e51a607`](https://github.com/ChinGuang/sdlc-code/tree/e51a607/spikes/t02-penpot-mcp)) — `penpotClient.ts`, `probe.ts` (live probe). **Maintained code:** `packages/clients/src/penpot` (`McpPenpotClient`)
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

## Measurements (live run, 2026-09-18 — raw output in [Appendix](#appendix-what-the-real-server-returned))

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
2. **Tab suspension (observed; not reproduced in T10).** When the Penpot tab is in the background, the browser throttles it and calls fail with `Tool execution failed: … The Penpot plugin tab appears to be suspended by the browser (no heartbeat for 39–45s). Please click/focus the Penpot tab…`. This happened three times while designing the dashboard on 2026-09-17; each time the next call succeeded right after the tab was focused. **Not measured by this probe:** whether an in-flight call blocks until the heartbeat timeout or fails immediately, how long recovery takes, and whether a call that failed this way had already partly executed. Backgrounding a tab cannot be automated from the probe; the T10 measurement below did it by hand.
   - **Recovery needs a human.** The client's retries (2 s, 5 s, 10 s ≈ 17 s total) only bridge a brief refocus; they will not recover a tab the user has left. After the schedule it raises `PenpotError(kind: "suspended")` with guidance, which should become an Escalation ("Focus the Penpot tab").
   - Because a failed call may have partly run, design code must be **idempotent** (e.g. find-or-create boards by name) before retrying.
   - `disconnected` (no plugin connected) is not retried — it escalates immediately.
   - **T10 measurement (2026-09-20, Windows 11, Penpot Cloud):** `packages/core/scripts/penpotSuspendProbe.ts` called `execute_code` every 3 s for 3 minutes, twice: once with the Penpot tab backgrounded behind another tab, once with the whole browser window minimised for ~90 s. **104 calls, 0 failures**, 445–672 ms each (median 483 ms), and an in-plugin counter incremented without gaps across both runs. So suspension does **not** follow automatically from a hidden tab on this setup; the three occurrences on 2026-09-17 came during long idle stretches. The open questions (does an in-flight call block or fail immediately, recovery time, partial execution) are therefore **still unanswered** — nothing reproduced them. The design treats suspension as possible anyway: boards are found-or-created by name and redrawn in place, so a retry after any failure is safe.
3. **Plugin reloads lose state.** The plugin's `storage` object was wiped once mid-session (helpers had to be redefined). Agents must not rely on state across `execute_code` calls — send self-contained code each time. (The T10 probe above kept its counter across two separate client connections, so `storage` usually survives; "usually" is exactly why nothing may depend on it.)
4. **No file creation from the plugin API.** `penpot` exposes `createPage()` and `openPage()` but nothing to create or open a file. The agent can only work in the file the user has open with the plugin connected. **This conflicts with the agreed "one Penpot file per Run".**
5. **CSS export works:** `penpot.generateStyle(shapes, { type: "css" })` returned CSS for the board (~2.6 s). `generateMarkup` (HTML/SVG) exists in the API but was not exercised. Could seed the Frontend Coding Agent's supplementary material.
6. **Board IDs returned by `execute_code` work directly with `export_shape`** within a session. Stability across plugin reloads was not tested.
7. **Non-JSON success output is rejected** by the client rather than passed through, so a proxy/gateway error page cannot masquerade as a result.
8. **Token hygiene:** `PENPOT_MCP_URL` embeds a user token. The client and probe redact `userToken=…` from every error message and stored result (`redactToken`, tested). Probe results stay local (`results/` is gitignored); the doc keeps what matters.

## Recommendation for T10 (UI Design Agent)

- Build on `McpPenpotClient` in `packages/clients/src/penpot`; keep code self-contained per call.
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

## Appendix: what the real server returned

Captured from Penpot Cloud MCP on 2026-09-18. The probe that produced this lives in the spike code at commit [`e51a607`](https://github.com/ChinGuang/sdlc-code/tree/e51a607/spikes/t02-penpot-mcp) (`pnpm probe` there). User tokens are redacted before anything is printed or saved.

### Raw `execute_code` responses

Exact `CallToolResult` bodies from `@modelcontextprotocol/sdk` `client.callTool(...)`. Note there is no `isError` on the failures (Finding 1).

Success — `return {a:1}`:

```json
{"content":[{"type":"text","text":"{
  \"result\": {
    \"a\": 1
  },
  \"log\": \"\"
}"}]}
```

Thrown error — `throw new Error('deliberate spike error')`:

```json
{"content":[{"type":"text","text":"Tool execution failed: Error: Error handling task: deliberate spike error"}]}
```

Runtime error — `return undefinedVar.x`:

```json
{"content":[{"type":"text","text":"Tool execution failed: Error: Error handling task: Cannot read properties of undefined (reading 'x')"}]}
```

Suspended tab (seen from Claude's Penpot MCP connection on 2026-09-17, same server):

```text
Tool execution failed: Error: The Penpot plugin tab appears to be suspended by the browser (no heartbeat for 39s). Please click/focus the Penpot tab to wake it, then retry.
```

### Probe run summary

Output of `probe.ts` for the run the Measurements table uses (CSS truncated; the exported PNG was a 480×200 dark board with the green text "Hello from sdlc-code via Penpot MCP", 6,604 bytes).

<details>
<summary>probe run JSON</summary>

```json
{
  "startedAt": "2026-09-18T01:29:10.778Z",
  "host": "design.penpot.app",
  "connect": {
    "ok": true,
    "ms": 618,
    "value": {
      "name": "penpot",
      "version": "1.0.0"
    }
  },
  "list_tools": {
    "ok": true,
    "ms": 221,
    "value": [
      "execute_code",
      "high_level_overview",
      "penpot_api_info",
      "export_shape"
    ]
  },
  "read_file_info": {
    "ok": true,
    "ms": 386,
    "value": {
      "file": "sdlc-code dashboard",
      "pages": [
        "Page 1"
      ],
      "current": "Page 1"
    }
  },
  "roundtrip_latency_ms": {
    "ok": true,
    "ms": 1908,
    "value": [
      378,
      389,
      377,
      387,
      377
    ]
  },
  "create_board_with_text": {
    "ok": true,
    "ms": 630,
    "value": {
      "boardId": "432b662e-d02e-8028-8008-a7cc8b9f1e1e",
      "page": "Page 1"
    }
  },
  "export_png": {
    "ok": true,
    "ms": 6977,
    "value": {
      "mimeType": "image/png",
      "bytes": 6604
    }
  },
  "generate_markup_css": {
    "ok": true,
    "ms": 2538,
    "value": "/* sdlc-code T02 spike (safe to delete) */\n.sdlccode-a7cc8b9f1e1e {\n  position: relative;\n  width: 480px;\n  height: 200px;\n  background: #0b0f14FF;\n  overflow: hidden;\n  z-index: 0;\n}\n\n/* Text */\n.text-a7cc8bb6d3b6 {\n  position: absolute;\n …"
  },
  "execution_error_is_classified": {
    "ok": true,
    "ms": 383,
    "value": {
      "kind": "execution",
      "message": "PenpotError: Tool execution failed: Error: Error handling task: deliberate spike error"
    }
  },
  "cleanup": {
    "ok": true,
    "ms": 2707,
    "value": "removed"
  },
  "finishedAt": "2026-09-18T01:29:27.160Z"
}
```

</details>
