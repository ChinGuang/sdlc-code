# 2. One Penpot page per Run, in a single workspace file

- Status: Accepted
- Date: 2026-09-18
- Supersedes: "one Penpot file per Run" (grilling session, 2026-09-17)

## Context

The UI Design Agent designs through the Penpot MCP server, which executes code inside the Penpot plugin running in the user's browser tab. Spike T02 ([docs/spikes/penpot-mcp.md](../spikes/penpot-mcp.md)) found that the plugin API can create and open **pages** (`createPage`, `openPage`) but has no way to create or open a **file**. The agent can only work in the file the user currently has open with the plugin connected.

The original decision was one Penpot file per Run, so each Run's design is isolated and linkable.

## Decision

Each Run gets its own **page** inside one **Penpot Workspace File** that the user keeps open with the MCP plugin connected. The page is named after the Run (e.g. `#014 Todo app`), holds one board per screen, and is what the Design Gate links to.

## Consequences

- Design Phase runs fully automatically; no manual file creation per Run.
- Runs share one file, so page naming must be unique and deterministic (Run id prefix), and design code must only touch its own page.
- The file grows over time; old Run pages may need archiving (manual for now).
- The user must open the Penpot Workspace File and connect the plugin once per session; the Design Phase checks this up front and escalates if the plugin is disconnected.
- If Penpot later exposes file creation to plugins, revisit — isolation per file would be preferable.
