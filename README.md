# sdlc-code

A multi-agent developer tool that turns a plain-language product request into a reviewed pull request for a production-ready full-stack application.

> Status: early build (M1). The monorepo, clients and CI exist; the agents are being built.

## Agents

- **Orchestrator** — executes the Slice Plan, dispatches Tasks, routes Issue Reports and blocking Findings to the owning agent.
- **System Design Agent** — architecture, Mermaid UML diagrams, Slice Plan and API Contract.
- **UI Design Agent** — designs screens in Penpot via Penpot MCP and writes the UI Spec.
- **Coding Agents** — Backend and Frontend agents work in parallel within each Slice, bound by the API Contract.
- **Testing Agent** — runs unit and API smoke tests in Nebius Token Factory Sandboxes and reports issues.
- **Code Review Agent** — linters first, then review against layered standards with cited rule IDs.

Humans approve at two Gates by default: the Design Gate and the PR Gate.

## Built with

- **NVIDIA Nemotron** open models (Ultra for reasoning roles, Super for coding and tool-heavy roles), served by **Nebius Token Factory**.
- **Nebius Token Factory Sandboxes** for isolated code execution and testing.
- **Penpot** (via Penpot MCP) for UI design.

Details on how each is used will be added as the project is built.

## Docs

- [CONTEXT.md](CONTEXT.md) — domain glossary
- [CODING_STANDARDS.md](CODING_STANDARDS.md) — coding rules (enforced by lint)
- [docs/PLAN.md](docs/PLAN.md) — implementation plan
- [docs/adr](docs/adr) — architecture decisions
- [docs/spikes](docs/spikes) — findings from the Sandbox, Penpot MCP and Nemotron spikes (their throwaway code is kept in git history)

## Repository layout

| Path | What |
|---|---|
| `packages/core` | Domain logic (agents, Orchestrator, Runs) |
| `packages/clients` | Token Factory, Sandboxes and Penpot MCP clients |
| `apps/server` | Local HTTP API on NestJS (127.0.0.1 only) |
| `apps/web` | Dashboard (Vite + React) |
| `apps/cli` | `sdlccode` command line |

## Development

Requires Node.js 22.12+ and pnpm 10.

```bash
pnpm install
cp .env.example .env   # then fill in your keys
pnpm check             # format check, lint, typecheck, tests
pnpm --filter @sdlc-code/server dev
pnpm --filter @sdlc-code/web dev
pnpm --filter @sdlc-code/cli sdlccode --help
```

### Agent models

Each agent role uses an NVIDIA Nemotron model on Token Factory: **Ultra** (`nvidia/Nemotron-3-Ultra-550b-a55b`) for Orchestrator, System Design and Code Review; **Super** (`nvidia/nemotron-3-super-120b-a12b`) for UI Design, Coding and Testing. Testing runs with reasoning off.

Override per role in `sdlc-code.config.json` (copy `sdlc-code.config.example.json`) or with `SDLC_MODEL_<ROLE>` env vars, then check:

```bash
pnpm --filter @sdlc-code/core config:check          # each role's model, thinking, capabilities + live check
pnpm --filter @sdlc-code/core agent:smoke          # one real agent-loop Step on Nemotron Super
pnpm --filter @sdlc-code/core design:smoke "Build a todo app"  # System Design Agent: design + Slice Plan + API Contract
pnpm --filter @sdlc-code/clients models:list        # NVIDIA models your key can use
pnpm --filter @sdlc-code/clients sandbox:whoami     # Sandbox permissions (Early Access)
pnpm --filter @sdlc-code/clients github:access owner/repo  # PAT can push and open PRs on the Target Repo
```

Full setup instructions come with T26.

## License

[Mozilla Public License 2.0](LICENSE)
