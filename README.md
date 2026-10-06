# sdlc-code

A multi-agent developer tool that turns a plain-language product request into a reviewed pull request for a full-stack application. Seven agents on NVIDIA Nemotron design it, draw it in Penpot, build it slice by slice, test it in isolated Nebius sandboxes and review it. You approve at two Gates; they do the rest.

```text
"A todo app where a person can add a todo, mark it done, and delete it."
        │
        ▼  System Design Agent + UI Design Agent (Penpot)   ──►  Design Gate (you approve)
        │
        ▼  per Slice: Backend + Frontend Coding Agents in parallel
        │              └─► Test Run in a Nebius sandbox ─► Issue Reports ─► the owning agent
        ▼  Code Review Agent (linters first, then a cited Review Standard)
        │
        ▼  PR Gate (you approve)  ──►  pull request on your GitHub repository
```

> **Status.** The pipeline works end to end and has been run twice against real services (see [What the demo Runs showed](#what-the-demo-runs-showed)). Both Runs ended as Draft PRs after Escalations, not as ready PRs: the honest account is in [docs/demo-run.md](docs/demo-run.md). One Stack Profile exists (React + Express + Prisma on SQLite, tested with Vitest).

## Contents

- [How it works](#how-it-works) · [Quick start](#quick-start) · [Configuration](#configuration) · [Using it](#using-it)
- [How Nemotron is used](#how-nemotron-is-used) · [Where Token Factory and Sandboxes come in](#where-token-factory-and-sandboxes-come-in)
- [What the demo Runs showed](#what-the-demo-runs-showed) · [Limits](#limits) · [Development](#development) · [Third-party software and terms](#third-party-software-and-terms) · [License](#license)

## How it works

| Agent | Does |
|---|---|
| **Orchestrator** | Runs the Slice Plan: dispatches Tasks, routes Issue Reports and blocking Findings to the owning agent, escalates to you when it cannot go on. |
| **System Design Agent** | The architecture, Mermaid UML diagrams, the Slice Plan (a Walking Skeleton first) and the API Contract (OpenAPI). |
| **UI Design Agent** | Designs the screens in Penpot through Penpot MCP and writes the UI Spec, with a screenshot of each screen. |
| **Backend and Frontend Coding Agents** | Build one Slice at the same time, bound by the API Contract, each in its own git worktree, each with tests. |
| **Testing Agent** | Runs the merged Slice in a sandbox (install, tests, boot, smoke tests, and a browser test of the app in headless Chromium) and turns what fails into Issue Reports with the cause the tools printed. |
| **Code Review Agent** | Linters first (ESLint and the TypeScript compiler), then a review of the diff against a layered Review Standard. Every Finding cites a Rule ID and a line the diff shows. |

- **Gates.** The Design Gate (after the documents) and the PR Gate (after review) are on by default. An *auto* Run skips them.
- **Escalations.** A Run stops for a person when a Task spends its Retry Budget, when the same failure comes back after a fix (a Loop), when no agent can be blamed, or when the Token Budget is spent. You get a brief of what went wrong and four ways on: retry with a hint, edit a document, skip the Slice, or abort. An abort can open a Draft PR of what passed.
- **Your code is never only in a sandbox.** Local git is the source of truth; the sandbox only executes ([ADR 0001](docs/adr/0001-local-git-is-source-of-truth-sandbox-only-executes.md)). A Run delivers to your repository through a feature branch and a pull request.
- **Review Standard.** The Stack Profile's baseline Rules, extended or overridden by a "Review Standard" section in your own `AGENTS.md`.

The domain words (Slice, Gate, Escalation, Working Memory, …) are defined in [CONTEXT.md](CONTEXT.md); the sequence diagrams are in [docs/design/uml.md](docs/design/uml.md).

## Quick start

You need **Node.js 22.12+** and **pnpm 10**, plus accounts for the services below. A Run spends real tokens and sandbox credit.

| For | You need |
|---|---|
| Models and sandboxes | A [Nebius Token Factory](https://tokenfactory.nebius.com) API key; Token Factory **Sandboxes** access (Early Access when this was written) and its project id |
| UI design | A [Penpot](https://penpot.app) Cloud file with the MCP plugin connected, and your Penpot MCP URL |
| Delivery (optional) | A GitHub repository to deliver into, and a token that can push to it and open pull requests |

```bash
git clone https://github.com/ChinGuang/sdlc-code.git
cd sdlc-code
pnpm install
cp .env.example .env     # then fill in the values (see Configuration); .env is git-ignored
```

Check that your keys work before spending anything on a Run:

```bash
pnpm --filter @sdlc-code/core config:check           # each role's model, and a live check of the key
pnpm --filter @sdlc-code/clients sandbox:whoami      # Sandbox permissions
pnpm --filter @sdlc-code/clients github:access owner/repo   # the token can push and open PRs there
pnpm --filter @sdlc-code/core penpot:smoke           # draws a fixed UI Spec in Penpot and exports PNGs
```

Start the local server and the dashboard (two terminals):

```bash
pnpm --filter @sdlc-code/server dev     # the API on http://127.0.0.1:4317
pnpm --filter @sdlc-code/web dev        # the dashboard on http://localhost:5173
```

Open the Penpot file in a browser tab with the MCP plugin connected and **leave the tab open**: Penpot MCP runs your design commands in that tab ([the spike](docs/spikes/penpot-mcp.md) explains why).

## Configuration

Secrets are read from the environment (`.env` is git-ignored; `.env.example` shows where each goes). They stay on your machine: a key is held in a private field of its client, is never put in a prompt or a sandbox, and the Penpot URL, which carries a user token, is never logged.

| Variable | For |
|---|---|
| `NEBIUS_API_KEY` | Token Factory (the models and the Sandboxes API) |
| `NEBIUS_AI_PROJECT` | The Token Factory project the Sandboxes belong to |
| `NEBIUS_SANDBOX_URL`, `NEBIUS_BASE_URL` | Optional: override the Sandboxes and Token Factory endpoints |
| `PENPOT_MCP_URL` | Your Penpot MCP endpoint (contains a user token) |
| `GITHUB_TOKEN` | Only for Runs that deliver to a repository. A fine-grained token on that repository with **Contents** and **Pull requests** set to *Read and write* |
| `SDLC_MODEL_<ROLE>` | Optional: a model id for one role, e.g. `SDLC_MODEL_CODE_REVIEW` |
| `SDLC_DATA_DIR` | Optional: where Runs are kept (default `.sdlc-runs/` in the repository) |
| `SDLC_CODE_PORT`, `SDLC_API_URL`, `SDLC_DASHBOARD_URL` | Optional: ports and addresses of the server, CLI and dashboard |
| `SDLC_MAX_PARALLEL_SLICES` | Optional, 1 to 4 (default 1): how many Slices the Slice Plan marks independent are built at the same time. Each costs a Coding Agent's tokens at once, so a Token Budget goes faster. |
| `SDLC_CODE_HOST`, `SDLC_ACCESS_TOKEN`, `SDLC_WEB_DIR`, `SDLC_SECURE_COOKIE` | Only for running on a network ([docs/deploy.md](docs/deploy.md)): a host other than `127.0.0.1` needs the token (16 characters or more) |

Change a role's model or reasoning in `sdlc-code.config.json` (copy [`sdlc-code.config.example.json`](sdlc-code.config.example.json)); `config:check` prints what each role will use. Restart the server after changing `.env` or the config file.

## Using it

**Dashboard.** *New run* takes the request, a Target Repo (empty keeps the Run local), the Gates (gated, or auto with none) and a Token Budget. A Run page shows the phases, the Slices and their Tasks, the activity feed, and the Gate or Escalation that is waiting for you; the documents, with the Penpot screenshots, are on its Design Gate tab. It stays live while the server runs.

**Command line.** The same Runs from a terminal:

```bash
pnpm --filter @sdlc-code/cli sdlccode run "A todo app with a title and a done flag" --repo you/your-repo --budget 8M
pnpm --filter @sdlc-code/cli sdlccode status <run> --follow
pnpm --filter @sdlc-code/cli sdlccode gate approve <run> --all          # the Design Gate
pnpm --filter @sdlc-code/cli sdlccode escalation show <run>             # what stopped it, and the ways on
pnpm --filter @sdlc-code/cli sdlccode escalation retry <run> "<hint>" --budget 11M
pnpm --filter @sdlc-code/cli sdlccode abort <run>                       # with a Draft PR of what passed
pnpm --filter @sdlc-code/cli sdlccode --help
```

Without `--repo` the Slice Commits stay in the Run's local repository, and the way out is a zip of the code as of the last Slice that passed:

```bash
pnpm --filter @sdlc-code/cli sdlccode export <run> [--out my-app.zip]
```

The dashboard's Run page has the same as *Download code (zip)* once a Slice has passed. The zip has the application's files with no git history (the Run's repository, with it, is `.sdlc-runs/<run>/repo.git`: `git clone` it for the history). A Run's files, database and workspaces are in `.sdlc-runs/`.

## How Nemotron is used

Every agent runs on an NVIDIA Nemotron model through Token Factory's OpenAI-compatible API: the larger **Ultra** for the roles that reason over the whole picture, **Super** for the roles that work in long tool loops. Defaults live in [`agentConfig.ts`](packages/core/src/config/agentConfig.ts); any role can be moved to another model.

| Role | Model | Reasoning | What the model does |
|---|---|---|---|
| Orchestrator | Nemotron 3 Ultra | on | Decides who owns a failure when the evidence is unclear, and writes the Escalation Brief. The rest of its work (ordering Slices, routing, budgets) is plain code. |
| System Design | Nemotron 3 Ultra | on | A tool loop that submits the design, the Slice Plan and the API Contract, each checked and sent back on errors, against the template's facts. |
| UI Design | Nemotron 3 Super | on | Writes the UI Spec and draws it in Penpot through MCP tool calls. |
| Backend / Frontend Coding | Nemotron 3 Super | on | A tool loop (read, write and edit files; a cheap self-check) until the Slice's code and tests are written. |
| Testing | none | — | Deterministic: the test script's result becomes Issue Reports in code. (A Nemotron Super role is configured, with reasoning off, but nothing calls it.) |
| Code Review | Nemotron 3 Ultra | on | Reviews the diff against the Review Standard and reports Findings that the diff must support. |

What the choice rests on is measured, not assumed: all four Nemotron models available on Token Factory made **0 malformed tool-call arguments in 521 tool calls**, and 16 of 16 structured outputs were schema-valid ([the tool-calling spike](docs/spikes/nemotron-tools.md)). The agent loop is built around what the spike found they differ on: parallel tool calls, multi-step accuracy and long-context recall.

## Where Token Factory and Sandboxes come in

**Token Factory** is the one endpoint behind every agent (chat completions with tool calling, and the model listing the config check uses). Measured on the first demo Run (the second behaved alike):

- the whole design package, from one request to the design documents and a Penpot design with a screenshot of each screen, took **about 2 minutes and 35k tokens**;
- the five Slices' coding Steps took about 77 minutes of agent time, backend and frontend running at the same time within each Slice.

**Nebius Sandboxes** run everything that executes generated code, so none of it runs on your machine:

- **Base Snapshot.** The Stack Profile's template with its dependencies installed is built once as a sandbox image (keyed by the image tag and a hash of the template), so a Test Run starts from it and installs only what a Slice added.
- **Test Run.** Install, unit tests, boot the API and smoke-test it, then open the app in headless Chromium (Playwright; the browser is in the Base Snapshot), starting from the Base Snapshot; the test script's result comes back as one machine-readable line.
- **Lint Run.** ESLint and the TypeScript compiler over the Slice Commits, in the same way.
- **Files go in, nothing is trusted to stay.** Processes do not survive between sandbox runs, so a smoke test starts and stops its server within one run; the source of truth stays in local git. Secrets are never sent into a sandbox. The measurements are in [the sandbox spike](docs/spikes/sandbox.md).

## What the demo Runs showed

The same request twice (a todo app), each into a new empty repository, in [docs/demo-run.md](docs/demo-run.md):

| | First Run | Second Run |
|---|---|---|
| Tokens | 13.5M | 14.1M |
| Escalations | 7 | 6 |
| Slices that passed their tests | 5 of 5 | 5 of 5 |
| Slices merged in the end | 5 of 5 pushed, the last sent back by Code Review | 4 of 5 (the last was sent back by Code Review) |
| Outcome | Draft PR | Draft PR |

Between the Runs the platform fixed what the first one found (the sandbox image, the lint, false review Findings, the Escalation Brief, a dashboard that went stale after a restart, the Draft PR text). What still costs most is the **Frontend Coding Agent's screen tests**: about 80% of the tokens in the first Run. Neither Run reached the PR Gate; a third, smaller Run is the way to show that.

## Self-hosted Penpot

Penpot Cloud is the default. To keep the designs on your own machine, `deploy/penpot/` runs Penpot's official Docker Compose stack (its MCP server included) bound to `127.0.0.1`, and sdlc-code needs only a different `PENPOT_MCP_URL`. Started and connected to with sdlc-code's own client; the drawing itself was not tried on it: [docs/penpot-self-hosted.md](docs/penpot-self-hosted.md).

## Running it on a server

By default the server listens on `127.0.0.1` and needs no sign-in. A container image (`docker build -t sdlc-code .`) runs the server and the dashboard together on a network address; it refuses to start there without an access token, and then every request needs it. It is a one-user tool with no accounts, and it was run and tested with Docker locally, not deployed to a cloud: see [docs/deploy.md](docs/deploy.md) for what it does, what it does not, and the one thing a server cannot change (the Penpot tab).

## Limits

- **One Stack Profile** (React 19 + Vite + Tailwind, Express 4, Prisma 6 on SQLite, Vitest). Others are a new Profile, not new code in the agents.
- **Early Access and a browser tab.** Sandboxes were Early Access when this was built, and Penpot MCP needs the Penpot tab open in your browser for the whole design.
- **A Run is expensive and not predictable.** Expect millions of tokens for a small app, and Escalations that need you. The Token Budget stops a Run rather than letting it run on.
- **One user.** The server listens on `127.0.0.1` and needs no sign-in; on a network it needs one shared access token and has no accounts. It is a single developer's tool, not a hosted service.

## Development

```bash
pnpm check                          # format check, lint, typecheck, tests (what CI runs)
pnpm --filter @sdlc-code/web build
```

| Path | What |
|---|---|
| `packages/core` | Domain logic: agents, Orchestrator, Runs, persistence |
| `packages/stack-profiles` | The starter template, its test and lint scripts, the baseline Review Standard |
| `packages/clients` | Token Factory, Sandboxes, Penpot MCP and GitHub clients |
| `apps/server` | Local HTTP API on NestJS (`127.0.0.1` only) with a Server-Sent Events stream per Run |
| `apps/web` | The dashboard (Vite + React) |
| `apps/cli` | The `sdlccode` command line |

- [CODING_STANDARDS.md](CODING_STANDARDS.md): the rules the code is written to (enforced by lint)
- [docs/PLAN.md](docs/PLAN.md): the plan · [docs/design](docs/design): the UML · [docs/adr](docs/adr): decisions · [docs/spikes](docs/spikes): what each service was measured to do
- [ROADMAP.md](ROADMAP.md): what was built, in order

Tests that call real services are skipped unless you opt in (for example `NEBIUS_LIVE=1`, `STACK_PROFILE_LIVE=1`), because they spend credit.

## Third-party software and terms

Every dependency's licence was checked, and the terms of the services this tool calls were read: the results are in [docs/compliance.md](docs/compliance.md). In short: no GPL, AGPL or LGPL dependency (the only MPL-2.0 package is a build tool); the services' terms allow what this tool does; the generated code is yours. One thing to know: the generated application starts as a copy of this repository's MPL-2.0 template, and the notes say what that means.

## License

[Mozilla Public License 2.0](LICENSE). Every source file starts with an `SPDX-License-Identifier: MPL-2.0` line; `pnpm lint` fails without it and `pnpm lint --fix` adds it.
