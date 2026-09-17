# sdlc-code

A multi-agent developer tool that turns a plain-language product request into a reviewed pull request for a production-ready full-stack application.

> Status: design phase. Nothing runnable yet.

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
- [docs/adr](docs/adr) — architecture decisions

## Setup

Coming soon.

## License

[Mozilla Public License 2.0](LICENSE)
