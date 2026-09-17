# sdlc-code — Implementation plan

Terms: [CONTEXT.md](../CONTEXT.md). Design: [docs/design/uml.md](design/uml.md), Penpot file "sdlc-code dashboard".

- **Today:** 2026-09-17 · **MVP complete:** 2026-10-18 · **Submission:** 2026-10-25
- **Every task:** new branch from latest `main` → implementation **with tests** → code review → PR for human review → merge.
- Branch naming: `feat/t05-token-factory-client`, `spike/t01-sandbox`, `docs/t26-readme`.
- A task is done when its acceptance criteria pass in CI and the PR is merged.

## Milestones

| Milestone | Dates | Goal |
|---|---|---|
| M0 Spikes | Sep 18 – Sep 19 | Remove the three biggest unknowns before building on them |
| M1 Foundation | Sep 20 – Sep 23 | Monorepo, clients, persistence, agent loop |
| M2 Design Phase | Sep 24 – Sep 29 | System Design Agent, UI Design Agent, Design Gate |
| M3 Build loop | Sep 30 – Oct 8 | Slices built in parallel, tested in sandbox, routed on failure |
| M4 Review & delivery | Oct 9 – Oct 12 | Linters, Code Review Agent, PR Gate, Draft PR |
| M5 Interfaces | Oct 9 – Oct 16 | Server API, dashboard, CLI |
| M6 Hardening & submission | Oct 17 – Oct 25 | End-to-end demo, README, video, submission |

M4 and M5 overlap: the server API (T21) is started as soon as M3's domain events are stable.

## Tasks

### M0 — Spikes

**T01 Spike: Nebius Sandbox REST from Node** · Sep 18
- Create a sandbox from an image, upload files, run a command, read stdout/exit code, snapshot and branch from a snapshot.
- Measure: max run time, outbound network (npm install), port binding for smoke tests, cost per run.
- Output: `docs/spikes/sandbox.md` + throwaway script. Decision: Base Snapshot approach confirmed or adjusted.

**T02 Spike: Penpot MCP from a Node MCP client** · Sep 18
- Connect with `@modelcontextprotocol/sdk`, run `execute_code` to create a board with text, `export_shape` to PNG.
- Confirm behaviour when the plugin tab is backgrounded (heartbeat suspension) and how to recover.
- Output: `docs/spikes/penpot-mcp.md`.

**T03 Spike: Nemotron tool calling on Token Factory** · Sep 19
- Ultra and Super: OpenAI-style tool calls, JSON-schema structured output, multi-turn tool loops of 10+ calls, context size, latency, token cost.
- Output: `docs/spikes/nemotron-tools.md` with the prompt/format rules the agent loop must follow.

### M1 — Foundation

**T04 Monorepo scaffold** · Sep 20
- pnpm workspaces: `packages/core`, `packages/clients`, `apps/server`, `apps/web`, `apps/cli`.
- TypeScript strict, ESLint, Vitest, GitHub Actions CI (lint, typecheck, test), `.env.example`.
- Acceptance: `pnpm lint && pnpm typecheck && pnpm test` green in CI with one sample test per package.

**T05 Token Factory client + agent config** · Sep 21
- Port the Nebius client from `agentops-triage-repair-engine`; streaming, tool calls, structured output, token usage.
- Config file (zod-validated): per-role model, Model Capabilities (`vision`, `penpotMcp`), defaults = Nemotron Ultra for Orchestrator/System Design/Code Review, Super for Coding/Testing/UI Design.
- Tests: config validation, request building, usage accounting (HTTP mocked).

**T06 GitHub client** · Sep 21
- Port and extend: create branch, push, open PR, open draft PR, PR description template. Fine-grained PAT from `.env`.
- Tests: request shapes with mocked API; secrets never logged.

**T07 Domain model + SQLite persistence** · Sep 22
- Entities from UML diagram 2; Run/Document state machines from diagrams 3 and 4 as pure functions.
- SQLite (better-sqlite3 + migrations), event rows for every Step.
- Tests: every legal and illegal state transition; repository round-trips.

**T08 Agent loop** · Sep 23
- Generic tool-calling loop: tools registry, max iterations, Transcript recording, token accounting against Token Budget, final Working Memory note.
- Tests: scripted fake model covering tool call → result → final answer, budget exceeded, malformed tool call.

### M2 — Design Phase

**T09 System Design Agent** · Sep 24 – Sep 25
- Produces System Design (Mermaid), Slice Plan (Walking Skeleton always first), API Contract (OpenAPI per Slice).
- Validators: Mermaid parses, OpenAPI valid, every Slice has contract endpoints, Slice 1 is the Walking Skeleton.
- Tests: validators with good/bad fixtures; agent run against recorded model responses.

**T10 Penpot client + UI Design Agent** · Sep 26 – Sep 27
- Penpot MCP client (from T02); one Penpot file per Run, one board per screen, configurable Penpot URL.
- Produces UI Spec (screens, routes, components, API Contract endpoints used, states, design tokens) + board exports.
- Validator: every UI Spec endpoint exists in the API Contract.
- Tests: UI Spec validator; MCP client against a fake MCP server.

**T11 Design Gate** · Sep 28 – Sep 29
- Per-document Verdicts, comments routed to owning agent, Stale cascade, re-open on any Approved Document change, auto mode skips.
- Tests: cascade rules (diagram 4), routing table, re-open behaviour.

### M3 — Build loop

**T12 Stack Profile v1** · Sep 30 – Oct 1
- Template: React + Vite + Tailwind frontend; Node API + Prisma backend (SQLite in tests); Vitest.
- Test script: install → unit tests → boot server → API smoke tests → stop, emitting machine-readable results.
- Baseline Review Standard rules: `CLEAN-*`, `REUSE-*`, `STRUCT-*`, `TEST-*`, `SEC-*` with severities.
- Tests: template passes its own test script locally.

**T13 Sandbox client + Test Runs** · Oct 2
- REST client from T01; Base Snapshot per Stack Profile (build once, reuse), Test Run = branch Base Snapshot + upload changed files + run script.
- Tests: client with mocked HTTP; one opt-in live test behind `NEBIUS_LIVE=1`.

**T14 Workspace manager** · Oct 3
- git worktrees per Coding Agent per Slice, merge into run branch, Slice Commit only after a passing Test Run, reset to last Slice Commit, discard unfinished worktrees.
- Tests: temp git repos covering merge, conflict detection, reset, discard.

**T15 Coding Agents** · Oct 4 – Oct 5
- Backend and Frontend Coding Agents with file tools scoped to their Workspace; run in parallel within a Slice.
- Inputs: Task, Approved Documents, Issue Reports, Working Memory; supplementary design material per Model Capabilities (UI Spec always; PNG if `vision`; live Penpot tools if `penpotMcp`).
- Tests: context builder per capability set; tools cannot write outside the Workspace.

**T16 Testing Agent + Issue Reports** · Oct 6
- Runs the Test Run, turns results into Issue Reports (failing test, error, evidence, suspected owner, signature for loop detection).
- Tests: parser fixtures for passing, failing unit, failing smoke, crash on boot.

**T17 Orchestrator** · Oct 7 – Oct 8
- Executes the Slice Plan; Owner resolution in fixed order (diagram 7); Retry Budget (3), Token Budget, Loop detection; Escalation with the four choices; auto-mode Failed path.
- Tests: owner resolution table-driven tests; budget and loop scenarios; escalation choices move the Run to the right state.

**T18 Checkpoints + resume** · Oct 8
- Checkpoint at every Step boundary; on startup resume unfinished Runs, discard in-flight Step, reset worktrees, rebuild context from Checkpoint + Working Memory (never Transcript).
- Tests: kill mid-Step simulation → resume → same next action.

### M4 — Review & delivery

**T19 Linters + Code Review Agent** · Oct 9 – Oct 10
- ESLint + `tsc --strict` in sandbox → linter Findings; Code Review Agent reviews diff against layered Review Standard (baseline + user `AGENTS.md`) and Approved Documents.
- Every Finding cites a Rule ID; only blocking Findings send work back.
- Tests: standard layering/override; Finding schema validation; blocking vs non-blocking routing.

**T20 PR Gate + Draft PR** · Oct 11 – Oct 12
- Push run branch, open PR with non-blocking Findings in description; PR Gate approve / request changes.
- Abort dialog option "Open draft PR with passed slices" (default on); auto-mode failure always opens Draft PR; only Slice Commits included; nothing pushed if no Slice Commit.
- Tests: Draft PR never contains unfinished Slice files; no push when unticked or zero Slice Commits.

### M5 — Interfaces

**T21 Server API + SSE** · Oct 9 – Oct 10
- Local-only (`127.0.0.1`) HTTP API: runs, gates, verdicts, escalation decisions, abort; SSE event stream per Run.
- Tests: route tests with in-memory core; SSE emits Step events in order.

**T22 Dashboard: Runs + Run Overview** · Oct 11 – Oct 13
- Boards 01 and 02: New run form, runs table, breadcrumbs, run tabs, phase stepper, Slice Plan with parallel lanes, Issue routing card, budget, live activity.
- Tests: component tests for status badges, stepper states, SSE-driven updates.

**T23 Dashboard: Design Gate, PR Gate, Escalation** · Oct 14 – Oct 15
- Boards 03, 04, 05: per-document verdicts with Stale cascade warning, Findings list with Rule IDs, Escalation dialog with draft PR checkbox.
- Tests: verdict submission, cascade warning visibility, abort payload includes checkbox value.

**T24 CLI `sdlccode`** · Oct 16
- `run`, `gate show`, `gate approve`, `gate request-changes`, `status --follow`, `abort [--no-draft-pr]` (board 06).
- Tests: argument parsing and API calls against a mock server.

### M6 — Hardening & submission

**T25 End-to-end demo run** · Oct 17 – Oct 20
- Create `ChinGuang/sdlc-code-demo-todo`; full gated run of the todo app request; fix what breaks; record timings and token usage.

**T26 README + compliance** · Oct 21 – Oct 22
- Setup and run instructions; how NVIDIA Nemotron is used per agent; where Token Factory accelerated the workflow; Nebius Sandboxes usage; third-party SDK/API licence and terms check; MPL 2.0 headers where needed.

**T27 Demo video + submission** · Oct 23 – Oct 25
- Record the demo (dashboard + Penpot canvas filling live + PR on GitHub); submit.

## Stretch (in order, only after T25 passes)

1. Playwright end-to-end tests in Stack Profile
2. Nebius AI Cloud deployment of the server
3. Local folder / zip export when no Target Repo
4. Docker Compose self-hosted Penpot
5. Parallel Slices
6. Sandbox tools exposed as an MCP server

## Risks

| Risk | Mitigation |
|---|---|
| Sandbox limits block smoke tests (network, ports, run time) | T01 first; fall back to unit + in-process supertest smoke tests |
| Nemotron tool-call reliability on long coding tasks | T03 first; per-agent model config allows switching a role's model |
| Penpot plugin tab suspends in background | T02 documents recovery; UI Design Agent retries after heartbeat loss and escalates with a clear message |
| Schedule slip | M4/M5 overlap; CLI can shrink to `run`/`approve`/`status` |

## Todoist layout (created after plan approval)

- Project **sdlc-code**, one section per milestone (M0–M6, Stretch).
- One task per T-number with due date, description = acceptance criteria, label `spike` / `feature` / `docs`.
- Sub-tasks per task: *branch from main*, *implement + tests*, *code review*, *open PR*.
