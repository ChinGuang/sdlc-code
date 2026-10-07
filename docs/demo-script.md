# Demo video: script and shot list (T27)

A three-minute video of one real Run, from a request to a pull request on GitHub. The submission is due **2026-10-25**; record by **10-23** so a failed take can be redone.

Everything below is true of the product as it is. Say only what the screen shows, and give a number only if it is in this file.

## What the video must show

1. The Penpot canvas filling live while the agents design.
2. The dashboard following a Run: Slices, the Backend and Frontend agents working at the same time, a Test Run in a Nebius sandbox.
3. The pull request on GitHub.
4. Where NVIDIA Nemotron, Token Factory and Nebius Sandboxes are used (the judges ask).

## The take: a rehearsal Run, recorded in pieces

A Run takes tens of minutes and costs real tokens, so the video is **edited from one Run**, not recorded live in one go. Record the screen for the whole Run, then cut. Start the screen recording before *New run* and keep it going; the dashboard stays live, so nothing is lost if a segment is missed.

**The request** (small, two features, no delete or toggle: the parts that cost most in the two earlier Runs):

> A guest book where a visitor can leave a message with their name, and see all messages, newest first.

**The settings:** a new empty repository, gated, Token Budget 8M.

## Script

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:15 | Title card: *sdlc-code*. Then the dashboard's *New run* form, the request typed in. | "You describe an application in plain words. Seven agents on NVIDIA Nemotron design it, build it, test it and review it, and hand you a pull request." |
| 0:15–0:25 | Click *Start run*; the Run page opens on Overview with the phase stepper. | "A Run is gated: I approve the design and the pull request. Everything between is theirs." |
| 0:25–0:55 | **Split screen**: the Penpot tab (screens being drawn) beside the dashboard. | "The System Design Agent writes the architecture, the Slice Plan and the API Contract. The UI Design Agent draws each screen in Penpot, through Penpot MCP, and checks it with a screenshot. The whole design took about two minutes in our first full Run." |
| 0:55–1:10 | *Design Gate* tab: the documents, one screenshot, *Approve* on each, then *Submit verdicts*. | "This is the first Gate. I read the documents and approve. Nothing is built until I do." |
| 1:10–1:50 | Overview: the Slice lanes. Backend and Frontend both "Writing code"; the Activity feed scrolling; then a Test Run line. | "Work goes in vertical Slices, a walking skeleton first. In each Slice a Backend and a Frontend agent work at the same time, bound by the API Contract. The merged Slice is tested in an isolated Nebius sandbox: install, unit tests, boot the API, smoke test. The source of truth stays in git; the sandbox only executes." |
| 1:50–2:10 | An Issue Report or Escalation if one happened (see *If a Run escalates*), else the Token Budget card and the *committed* line for the Slice. | "When a test fails, an Issue Report with the cause the tools printed goes to the agent that owns it, not to a person. If the same failure comes back, the Run stops and tells me why, with a brief and four ways on." |
| 2:10–2:30 | *Code Review & PR* tab: the Findings with Rule IDs, then *Approve*. | "Linters first, then the Code Review Agent against the Review Standard. Every Finding cites a rule and a line the diff shows. The second Gate is the pull request." |
| 2:30–2:50 | GitHub: the pull request, its description, the Files changed tab. | "And here is the pull request, in a repository I own, with what was built, what passed and the Findings that did not block." |
| 2:50–3:00 | The README's *Limits* section or the closing card. | "It is a local tool and the Runs are not cheap: the honest numbers are in the README. Code, docs and the three Runs are in the repository." |

## Facts you may quote (all in the repository)

- Seven agents; Nemotron 3 **Ultra** for the Orchestrator, System Design and Code Review, **Super** for UI Design and the two Coding agents ([README](../README.md#how-nemotron-is-used)).
- Tool calling: 0 malformed arguments in 521 tool calls, 16 of 16 schema-valid outputs, across the four Nemotron models on Token Factory ([spike](spikes/nemotron-tools.md)).
- Design phase of the first Run: about 2 minutes, 35k tokens ([demo-run.md](demo-run.md)).
- Two earlier Runs of a todo app: 13.5M and 14.1M tokens, both ending as Draft PRs after Escalations. Say so if asked; do not say a Run "just works".

## If a Run escalates while recording

It may: both full Runs did. Do not hide it; it is half of the product.

1. Keep recording. Open *Overview*: the Escalation dialog shows the brief (what is failing, what was tried, the likely cause, a suggested hint).
2. Read one line of the brief aloud, send the hint (*Retry with a hint*), and keep going. Cut the waiting.
3. If the Token Budget is spent, raise it in the dialog (the Run continues) and note the new total.
4. If a Run cannot reach the PR Gate after two Escalations, abort with a Draft PR and use the take for the design and Test Run segments; shoot the PR segment from the next Run.

Material already recorded or kept for cutting in: Run 2's Escalation dialog and its Draft PR on GitHub (`ChinGuang/sdlc-code-demo-todo-2`, #1).

## Before recording

- [ ] `main` is current and `pnpm check` passes; `pnpm install` on a fresh clone works (done for T26).
- [ ] `.env` has valid keys: run `config:check`, `sandbox:whoami`, `github:access <owner/repo>` and `penpot:smoke` from the README's *Quick start*.
- [ ] A new, empty GitHub repository, and the token's repository access includes it (a 403 on push means it does not).
- [ ] The Penpot file open in a browser tab with the MCP plugin connected, and that tab visible on screen (Penpot waits on it).
- [ ] Server and dashboard running: `pnpm --filter @sdlc-code/server dev`, `pnpm --filter @sdlc-code/web dev`.
- [ ] The screen at 1920x1080, browser zoom 100%, notifications off, no other repositories, tokens or `.env` on screen. The Penpot URL carries a token: never show the `.env` file or the address with `userToken`.
- [ ] Credit: a rehearsal Run can spend up to 8M tokens plus sandbox credit.

## After recording

- [ ] Cut to three minutes; keep the Penpot canvas filling and the PR on GitHub in full.
- [ ] Check the video for keys, tokens, e-mail addresses and the `userToken` URL.
- [ ] Upload; put the link in the submission; check it plays logged out.
- [ ] Submit before 2026-10-25 and keep the confirmation.
