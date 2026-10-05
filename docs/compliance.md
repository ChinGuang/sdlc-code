# Third-party software and terms (T26)

What sdlc-code is built on, under which licences, and what the services it calls allow. Checked on **2026-10-05**. This is a developer's reading of the public texts, not legal advice; where a page could not be read, it says so.

## 1. This project

[Mozilla Public License 2.0](../LICENSE), declared in the root `package.json` and in every workspace package's `package.json`.

MPL 2.0 is a **file-level** copyleft: changes to an MPL file that you distribute must be shared under the MPL, while files of your own that sit beside it keep their own licence. This matters in one place:

- **The generated application starts as a copy of the Stack Profile template** (`packages/stack-profiles/templates/react-node`), which is MPL 2.0 like the rest of the repository. Whoever receives a generated application and has changed one of those template files must keep that file under the MPL if they distribute it. The files the agents write are the user's own (see section 4). If the template should be freer than that, it needs its own licence file in its directory; that is a decision for the project, not a check.

## 2. Dependencies

`pnpm licenses list` over the lockfile (`pnpm-lock.yaml`), 2026-10-05.

| Licence | Production | All (with development tools) |
|---|---|---|
| MIT | 176 | 339 |
| ISC | 44 | 51 |
| BSD-3-Clause | 9 | 13 |
| BSD-2-Clause | 8 | 15 |
| Apache-2.0 | 3 (`@chevrotain/types`, `reflect-metadata`, `rxjs`) | 22 |
| `(MPL-2.0 OR Apache-2.0)` | 1 (`dompurify`) | 1 |
| 0BSD, Unlicense | 1 each (`tslib`, `robust-predicates`) | 1 each |
| MPL-2.0 | 0 | 2 (`lightningcss` and its platform build, which Vite uses to build and test the dashboard) |
| Others | 0 | `minimatch` (BlueOak-1.0.0), `@csstools/color-helpers` (MIT-0), `@swc/core` platform build (Apache-2.0 AND MIT) |
| No `license` field | 1 (`khroma`) | 1 |

- **No GPL, AGPL or LGPL package** is installed.
- **MPL-2.0 packages** are build-time tools (`lightningcss`, through Vite); none is part of what the server or the dashboard runs. File-level copyleft would apply to changes to that package's own files, and none are made.
- **`dompurify`** is dual-licensed; it is used under Apache-2.0.
- **`khroma`** has no `license` field in its `package.json` but ships a `license` file that is the MIT text (Fabio Spampinato, Andrew Maney).

### Direct dependencies

| Package | Used by | Licence |
|---|---|---|
| `@modelcontextprotocol/sdk` | `packages/clients` (Penpot MCP client) | MIT |
| `@nestjs/common`, `core`, `platform-express`, `reflect-metadata`, `rxjs` | `apps/server` | MIT, MIT, MIT, Apache-2.0, Apache-2.0 |
| `better-sqlite3` | `packages/core` (persistence, ADR 0003) | MIT |
| `@seriousme/openapi-schema-validator`, `zod` | `packages/core` (`zod` also in `clients`, `stack-profiles`, `server`) | MIT |
| `linkedom`, `yaml` | `packages/core` | ISC |
| `mermaid`, `react`, `react-dom` | `apps/web` (`mermaid` also in `packages/core`) | MIT |

The development tools (TypeScript, Vitest, ESLint, Prettier, Vite, `tsx`) are MIT or Apache-2.0 (TypeScript).

### What the generated applications use

The template's dependencies are installed into the applications the agents write, in the sandbox, not into this repository: React, `react-router-dom`, Express, `zod`, Vite, Vitest, Tailwind CSS, Testing Library (MIT); Prisma (Apache-2.0); TypeScript (Apache-2.0). They carry no copyleft obligation for the generated code.

## 3. Services this tool calls

### Nebius Token Factory (models and Sandboxes)

Source: [Token Factory Terms of Service](https://docs.tokenfactory.nebius.com/legal/terms-of-service).

- **Inputs and outputs are the customer's** (§10b); Token Factory may host, cache and store them to run the service (§7) and uses them to train *smaller speculative-decoding models*, which can be opted out of by emailing `tokenfactory-support@nebius.com` (§7). **Code from a Project Request and from the agents therefore goes to Nebius**; do not use a Run on code or requests you may not send to a third party.
- **Not allowed:** outputs for military purposes, surveillance or biometric processing, and using the Service to develop a product that competes with it (§5f), and breaking rate limits (§5e). This tool is a client of the Service and not a competing inference service.
- **Model licences apply on top** ("EULA", incorporated by reference); Token Factory gives no commitments about third-party models (§11a).
- **The API key** is the customer's to keep secret and they answer for what is done with it (§5b, §5g). Here it is read from the environment, held in a private field and never sent to a sandbox or into a prompt.
- Free credits can be withdrawn at any time (§6c).

**Sandboxes** were in Early Access when the spikes were run. Their separate terms, if any, were **not found**: they are used under the Terms above and the project's Early Access agreement. Check them before anything beyond the demonstration.

### NVIDIA Nemotron models

The models are open-weight and served by Token Factory; the sandbox, the key and the hosting are Nebius's, the licence is NVIDIA's.

- The **Super** model card states the licence: *NVIDIA Nemotron Open Model License* ([text](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/)) and says the model is ready for commercial use.
- It grants a perpetual, worldwide, no-charge, royalty-free licence (§2), says NVIDIA claims **no ownership of outputs** (§2), and asks for a NOTICE ("Licensed by NVIDIA Corporation under the NVIDIA Nemotron Model License") only when **a derivative work is redistributed** (§3(c)). This tool only calls the models through an API and distributes neither weights nor derivatives, so no notice is required; the README says what is used and links to NVIDIA anyway.
- NVIDIA's marks may be used only to say where a model comes from (§4). The README and the demo do that and nothing else.
- Not read: the model card for **Ultra** (the page needed a login). It is assumed to carry the same licence family; confirm it before publishing.
- The similar *NVIDIA Open Model License* ([text](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/)) also leaves outputs to the user and asks nothing of API use.

### Penpot (design, through Penpot MCP)

Sources: [Penpot terms](https://penpot.app/terms), [Penpot MCP server](https://penpot.app/penpot-mcp-server).

- Penpot is MPL 2.0 itself; designs stay the user's (§4.3), with a licence for Penpot to host and process them.
- Programmatic use has no stated rate limit, but "unreasonable requests" and bots can get an account suspended (§5.2), and a fair-use cap is mentioned (§3.10). The tool makes a handful of calls per design.
- The MCP URL contains the user's token: the user is responsible for it (§3.6 to §3.8). The tool never logs it.
- Plugins are not vetted by Penpot and may be removed by it (§4.6): the design phase depends on the MCP plugin staying available.

### GitHub (delivery)

Source: [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service).

- Automated use of the API is allowed within the rate limits; abusive or excessive requests are not (section H). A Run makes a few calls: a branch lookup, the pushes and a pull request.
- The token is the user's, and fine-grained: the tool asks only for Contents and Pull requests on one repository.
- Content the user pushes is theirs; reviewing, testing and owning AI-written code is the user's responsibility (section J).

## 4. What the tool produces

- **Generated code** is the user's. NVIDIA claims no ownership of outputs and neither does Nebius (§10b). Outputs may not be unique, and may resemble existing code, so a person reviews the pull request before merging it; that is what the PR Gate is for.
- **Secrets.** A key is never sent to a sandbox or into a prompt. The agents' Workspaces hold only the template and the files the agents write, they may write only to the paths a Stack Profile allows, and secret files are left out when a Workspace is committed.

## 5. Source-file notices

An SPDX identifier line (`SPDX-License-Identifier: MPL-2.0`) at the top of every source file, and a lint rule that keeps it there, is the follow-up to this task.

## 6. Open points

1. The Ultra model card, and any separate Sandboxes terms, were not read (see above).
2. The licence of the template inside generated applications (section 1).
3. A dependency scan is a snapshot of the lockfile; run `pnpm licenses list` again after any dependency change.
