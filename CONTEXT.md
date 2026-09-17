# CONTEXT

Glossary for the multi-agent developer tool that turns a product request into a reviewed pull request for a full-stack application.

## Work

**Project Request** — What a developer asks for in plain language ("Build a todo app with auth"). Starts exactly one Run.

**Run** — One journey of a Project Request through the agents, from request to pull request. Has a mode that decides which Gates are active.

**Gate** — A point in a Run where a human must approve or comment before work continues. Defaults: the **Design Gate** (after System Design and UI Design) and the **PR Gate** (after Code Review). A Run in auto mode skips Gates.

**Verdict** — A human's decision on one document at a Gate: Approve, or Request Changes with comments. Comments go to that document's owning agent.

**Stale** — A document built on another document that has since changed. The UI Spec and Penpot design become Stale whenever the System Design, Slice Plan or API Contract changes, and are redone before the Gate re-opens.

**Task** — A unit of work the Orchestrator hands to exactly one agent.

**Slice** — A vertical feature (e.g. "Auth") built end to end: backend, frontend and tests. Slices are built one at a time; each passing Slice produces a Slice Commit. Within a Slice, backend and frontend Tasks run at the same time.

**Slice Plan** — The ordered list of Slices for a Run, proposed by the System Design Agent and reviewed at the Design Gate. The Orchestrator executes it; it does not author it.

**Walking Skeleton** — Always the first Slice: the Stack Profile's template, database, a health check, one empty screen and the test script, proving the pipeline works before feature work.

**API Contract** — The endpoints and request/response schemas for a Slice, produced by the System Design Agent. The only agreement the Backend and Frontend Coding Agents share while working in parallel.

**UI Spec** — The text description of every screen written by the UI Design Agent alongside the Penpot design: route, components, which API Contract endpoints each uses, fields, states and design tokens. The source of truth for frontend work and its review; Penpot exports and live Penpot access are supplementary.

**Model Capabilities** — What a configured model can accept (e.g. images, live Penpot access). Decides which supplementary design material an agent receives; never changes the UI Spec's role.

**Design Phase** — System Design, then UI Design (which builds on the System Design), then the Design Gate reviewing both together. Rejection may send work back to either agent.

**Issue Report** — A structured failure found by the Testing Agent: symptoms, evidence and a *suspected* owner. Always sent to the Orchestrator, never directly to another agent.

**Owner** — The agent the Orchestrator assigns to fix an Issue Report, decided by comparing evidence against the Approved Documents in a fixed order: code deviates from a document → that side's Coding Agent; documents contradict each other → the deviating design agent; requirement missing or wrong → System Design Agent; undecidable → human.

**Approved Documents** — The System Design, Slice Plan, API Contract and UI Spec once passed at the Design Gate. Any later change to them re-opens the Design Gate.

**Step** — One agent working on one Task until it hands back a result. A Step either completes or is discarded; an interrupted Step is redone from the last Slice Commit, never resumed mid-way.

**Checkpoint** — Everything saved at a Step boundary that lets a Run continue after the system stops: Approved Documents, Slice plan, Task status, last Slice Commit, Issue Reports, Findings, Gate decisions, retry counts and Working Memory.

**Working Memory** — A short note an agent writes at the end of each Step (what was tried, what failed, what to try next). Given to the agent's fresh context on retry or resume so it does not repeat failed attempts.

**Transcript** — The full record of an agent's messages and tool calls. For display and debugging only; never used to resume a Run.

**Retry Budget** — How many times a Task may loop back after Issue Reports or blocking Findings before the Run escalates. Default 3.

**Token Budget** — The maximum model usage a Run may spend before it escalates.

**Loop** — An Issue Report matching an earlier one in the same Task (same failing test and error). Escalates immediately, without spending the remaining Retry Budget.

**Escalation** — Pausing a Run for a human, with a failure summary and Working Memory. The human chooses: retry with a hint, edit Approved Documents, skip the Slice, or abort. Aborting offers to open a Draft PR (on by default). In auto mode there is no human: the Run ends and always opens a Draft PR.

**Draft PR** — A pull request opened as a draft when a Run stops early. Contains only Slice Commits (Slices that passed testing) plus a failure report; code from the unfinished Slice is never included.

## Agents

**Orchestrator** — Plans a Run, creates Tasks, routes Issue Reports and blocking Findings to the owning agent. Never writes code or designs.

**System Design Agent** — Produces the architecture, Mermaid UML diagrams and the API Contract for a Run.

**UI Design Agent** — Produces the target application's screens in Penpot.

**Coding Agent** — Writes the application from a Task plus the System Design and UI Design. Works as either a **Backend Coding Agent** or a **Frontend Coding Agent** within a Slice.

**Testing Agent** — Runs tests against the application and emits Issue Reports.

**Code Review Agent** — Checks the application against Review Standards and the spec; emits Findings.

_Avoid_: "subagent" as a synonym for a specific agent role.

## Standards and output

**Stack Profile** — A supported target stack: the starter template, how it is tested, and its baseline Review Standards. One exists at launch.

**Review Standard** — A layered set of Rules: the Stack Profile baseline, extended or overridden by the user's own standards.

**Rule** — A single checkable requirement with an ID (e.g. `SEC-01`), a pass/fail test and a severity (minor, major, blocking).

**Finding** — A Rule violation reported by linting or the Code Review Agent. Always cites a Rule ID. Only blocking Findings send work back.

**Target Repo** — The user's existing GitHub repository the Run delivers into via a feature branch and pull request.

**Slice Commit** — The committed state of the application after a Slice passes testing. The source of truth during a Run and the rollback point for failed attempts; the Run's Slice Commits become the pull request to the Target Repo.

**Workspace** — Where one Coding Agent writes code for a Task. Backend and Frontend Coding Agents each have their own Workspace within a Slice; the Orchestrator merges them.

**Test Run** — One execution of a Slice's merged code in the sandbox: install, tests, boot, smoke tests. The sandbox only executes; it never holds the source of truth.

**Base Snapshot** — A cached sandbox state per Stack Profile with the template and dependencies already installed. Every Test Run starts from it and adds only the changed code.

_Avoid_: "Snapshot" to mean the application's source of truth — use Slice Commit.
