# sdlc-code — UML

Design-phase diagrams for review. Terms follow [CONTEXT.md](../../CONTEXT.md); the key storage decision is [ADR 0001](../adr/0001-local-git-is-source-of-truth-sandbox-only-executes.md). UI screens live in the Penpot file "sdlc-code dashboard".

1. [Component diagram](#1-component-diagram)
2. [Domain class diagram](#2-domain-class-diagram)
3. [Run lifecycle](#3-run-lifecycle-state) and [stopping early](#3b-stopping-early--what-goes-into-the-draft-pr-sequence)
4. [Document lifecycle](#4-document-lifecycle-state)
5. [Design Phase and Design Gate](#5-design-phase-and-design-gate-sequence)
6. [Slice execution](#6-slice-execution-sequence)
7. [Owner resolution and escalation](#7-owner-resolution-and-escalation-activity)
8. [Code review and PR Gate](#8-code-review-and-pr-gate-sequence)
9. [Resume after restart](#9-resume-after-restart-sequence)

## 1. Component diagram

One local server owns every Run; the dashboard and CLI are thin clients. Agents run locally and call Nebius Token Factory for inference. The sandbox only executes Test Runs.

```mermaid
flowchart LR
  subgraph Clients
    WEB["apps/web<br/>Dashboard"]
    CLI["apps/cli<br/>sdlccode"]
  end

  subgraph Local["Local machine"]
    SRV["apps/server<br/>HTTP API + SSE"]
    subgraph Core["packages/core"]
      ORC["Orchestrator"]
      AG["Agents<br/>System Design · UI Design<br/>Backend/Frontend Coding<br/>Testing · Code Review"]
      LOOP["Agent loop<br/>tool calling"]
      ROUTE["Owner resolver"]
      BUDGET["Retry / Token budget<br/>Loop detection"]
      CKPT["Checkpoint store"]
      WS["Workspace manager<br/>git worktrees"]
    end
    subgraph Adapters["packages/clients"]
      NEB["Token Factory client"]
      SBX["Sandbox REST client"]
      PEN["Penpot MCP client"]
      GH["GitHub client"]
    end
    DB[("SQLite")]
    GIT[("Local git repo<br/>Slice Commits")]
    PROF["Stack Profile<br/>template · test script<br/>Review Standard"]
    BROWSER["Browser tab<br/>Penpot + MCP plugin"]
  end

  subgraph Nebius
    TF["Token Factory<br/>NVIDIA Nemotron models"]
    SB["Sandboxes<br/>Base Snapshot · Test Runs"]
  end
  PPC["Penpot Cloud"]
  GHUB["GitHub<br/>Target Repo"]

  WEB -- "REST + SSE" --> SRV
  CLI -- "REST + SSE" --> SRV
  SRV --> ORC
  ORC --> AG
  AG --> LOOP
  ORC --> ROUTE
  ORC --> BUDGET
  ORC --> CKPT
  ORC --> WS
  CKPT --> DB
  WS --> GIT
  ORC --> PROF
  LOOP --> NEB --> TF
  ORC --> SBX --> SB
  LOOP --> PEN --> BROWSER --> PPC
  ORC --> GH --> GHUB
```

## 2. Domain class diagram

```mermaid
classDiagram
  direction LR

  class Run {
    id
    projectRequest
    mode: gated | auto
    status: RunStatus
    tokenBudget
    tokensUsed
  }
  class TargetRepo {
    owner
    name
    baseBranch
    runBranch
  }
  class Gate {
    kind: design | pr
    status: open | passed
  }
  class Verdict {
    decision: approve | requestChanges
    comments
  }
  class Document {
    kind: DocumentKind
    version
    status: DocumentStatus
    ownerAgent
  }
  class SystemDesign {
    mermaidDiagrams
  }
  class SlicePlan
  class APIContract {
    openapi
  }
  class UISpec {
    screens
    designTokens
  }
  class PenpotDesign {
    fileUrl
    boards
  }
  class Slice {
    order
    title
    isWalkingSkeleton
    status: pending | building | testing | passed | skipped
  }
  class Task {
    agentRole
    status
    retries
  }
  class Step {
    status: running | completed | discarded
  }
  class Workspace {
    worktreePath
    branch
  }
  class SliceCommit {
    sha
  }
  class TestRun {
    sandboxId
    passed
    logs
  }
  class IssueReport {
    failingTest
    error
    evidence
    suspectedOwner
    signature
  }
  class Finding {
    ruleId
    severity
    location
    suggestion
    source: linter | reviewAgent
  }
  class Rule {
    id
    description
    severity: minor | major | blocking
  }
  class ReviewStandard {
    layers: baseline + user
  }
  class StackProfile {
    name
    template
    testScript
    baseSnapshotId
  }
  class AgentConfig {
    role
    model
  }
  class ModelCapabilities {
    vision
    penpotMcp
  }
  class Checkpoint {
    createdAt
  }
  class WorkingMemory {
    agentRole
    note
  }
  class Transcript {
    messages
    toolCalls
  }
  class Escalation {
    trigger: retryBudget | tokenBudget | loop | undecidableOwner
    choice: retryWithHint | editDocuments | skipSlice | abort
    openDraftPrOnAbort: boolean = true
  }
  class PullRequest {
    number
    draft
  }

  Run "1" --> "1" TargetRepo
  Run "1" --> "1" StackProfile
  Run "1" *-- "2" Gate
  Run "1" *-- "5" Document
  Run "1" *-- "1..*" Slice
  Run "1" *-- "0..*" Checkpoint
  Run "1" --> "0..1" PullRequest
  Run "1" *-- "0..*" Escalation
  Gate "1" *-- "0..*" Verdict
  Verdict "0..*" --> "1" Document
  Document <|-- SystemDesign
  Document <|-- SlicePlan
  Document <|-- APIContract
  Document <|-- UISpec
  Document <|-- PenpotDesign
  UISpec ..> APIContract : builds on
  PenpotDesign ..> UISpec : described by
  SlicePlan "1" o-- "1..*" Slice
  Slice "1" *-- "1..*" Task
  Slice "1" --> "0..1" SliceCommit
  Slice "1" *-- "0..*" TestRun
  Task "1" *-- "0..*" Step
  Task "1" --> "0..2" Workspace
  Step "1" --> "0..1" WorkingMemory
  Step "1" --> "1" Transcript
  TestRun "1" --> "0..*" IssueReport
  Finding "0..*" --> "1" Rule
  ReviewStandard "1" *-- "1..*" Rule
  StackProfile "1" --> "1" ReviewStandard
  Task --> AgentConfig
  AgentConfig "1" --> "1" ModelCapabilities
  Checkpoint --> SliceCommit : last
  Checkpoint --> WorkingMemory : includes
```

## 3. Run lifecycle (state)

```mermaid
stateDiagram-v2
  [*] --> Designing
  Designing --> AwaitingDesignGate : documents ready (gated)
  Designing --> Building : documents ready (auto)
  AwaitingDesignGate --> Designing : changes requested
  AwaitingDesignGate --> Building : all documents approved

  state Building {
    [*] --> SliceInProgress
    SliceInProgress --> Testing : workspaces merged
    Testing --> SliceInProgress : issue routed to Coding Agent
    Testing --> SliceCommitted : Test Run passed
    SliceCommitted --> SliceInProgress : next slice
    SliceCommitted --> [*] : last slice
  }

  Building --> Designing : issue owned by a design agent
  Building --> Reviewing : all slices committed
  Reviewing --> Building : blocking findings
  Reviewing --> AwaitingPRGate : PR opened (gated)
  Reviewing --> Done : PR opened (auto)
  AwaitingPRGate --> Building : changes requested
  AwaitingPRGate --> Done : approved

  Building --> Escalated : retry, token budget, loop or undecidable owner
  Reviewing --> Escalated : retry or token budget
  Escalated --> Building : retry with hint / skip slice
  Escalated --> Designing : edit approved documents
  Escalated --> Aborted : abort

  Building --> Failed : limit hit in auto mode
  Reviewing --> Failed : limit hit in auto mode
  Failed --> [*] : draft PR with passed slices
  Done --> [*]
  Aborted --> [*] : draft PR with passed slices if checkbox ticked (default)
```

## 3b. Stopping early — what goes into the Draft PR (sequence)

Applies to an auto-mode failure and to an abort with "Open draft PR" ticked. Only Slice Commits are pushed; the unfinished Slice's worktrees are discarded and never merged into the run branch.

```mermaid
sequenceDiagram
  autonumber
  actor Dev as Developer
  participant UI as Dashboard / CLI
  participant O as Orchestrator
  participant W as Workspace manager (git)
  participant G as GitHub

  alt gated: Escalation dialog
    Dev->>UI: Abort run, "Open draft PR with passed slices" ticked (default)
    UI->>O: abort(openDraftPr = true)
  else auto: limit hit
    O->>O: fail(openDraftPr = true)
  end
  O->>W: discard backend + frontend worktrees of unfinished Slice
  O->>W: reset run branch to last Slice Commit
  W-->>O: run branch = Slice Commits only
  alt openDraftPr and at least one Slice Commit
    O->>G: push run branch
    O->>G: open draft PR "[Aborted] or [Failed] title — N of M slices"
    Note over O,G: description = passed Slices, failed Slice + Issue Reports,<br/>Working Memory. No code from the unfinished Slice.
    G-->>O: draft PR number
  else checkbox unticked or no Slice Commit
    O->>O: nothing pushed, run branch stays local
  end
  O-->>UI: Run Aborted / Failed
```

Any Run state except `Done`, `Failed` and `Aborted` can be interrupted and resumed from its last Checkpoint (see diagram 9).

## 4. Document lifecycle (state)

```mermaid
stateDiagram-v2
  [*] --> Drafting
  Drafting --> InReview : owner agent finished
  InReview --> Approved : verdict approve
  InReview --> ChangesRequested : verdict request changes
  ChangesRequested --> Drafting : owner agent revises
  Approved --> Drafting : changed after approval (re-opens Design Gate)
  Approved --> Stale : upstream document changed
  InReview --> Stale : upstream document changed
  Stale --> Drafting : UI Design Agent redoes
```

Upstream relationships: System Design, Slice Plan and API Contract → UI Spec and Penpot design.

## 5. Design Phase and Design Gate (sequence)

```mermaid
sequenceDiagram
  autonumber
  actor Dev as Developer
  participant UI as Dashboard / CLI
  participant O as Orchestrator
  participant SD as System Design Agent
  participant UD as UI Design Agent
  participant TF as Token Factory (Nemotron)
  participant P as Penpot MCP
  participant DB as Checkpoint store

  Dev->>UI: Project Request, Target Repo, mode
  UI->>O: start Run
  O->>DB: Checkpoint (Run created)
  O->>SD: Task: design system
  loop agent loop
    SD->>TF: chat + tools
    TF-->>SD: diagrams, Slice Plan, API Contract
  end
  SD-->>O: System Design, Slice Plan (Walking Skeleton first), API Contract
  O->>DB: Checkpoint
  O->>UD: Task: design UI (with API Contract)
  loop agent loop
    UD->>TF: chat + tools
    UD->>P: create file / boards / shapes
    P-->>UD: shape ids, exports
  end
  UD-->>O: UI Spec, Penpot file URL
  O->>DB: Checkpoint

  alt gated mode
    O-->>UI: Design Gate open
    Dev->>UI: Verdict per document
    UI->>O: verdicts
    alt all approved
      O->>DB: Checkpoint (Approved Documents)
    else API Contract / Slice Plan / System Design changes requested
      O->>O: mark UI Spec and Penpot design Stale
      O->>SD: revise with comments
      SD-->>O: revised documents
      O->>UD: redo stale documents
      UD-->>O: revised UI Spec, Penpot
      O-->>UI: Design Gate re-opened
    else only UI documents changes requested
      O->>UD: revise with comments
      UD-->>O: revised UI Spec, Penpot
      O-->>UI: Design Gate re-opened
    end
  else auto mode
    O->>DB: Checkpoint (documents accepted)
  end
```

## 6. Slice execution (sequence)

```mermaid
sequenceDiagram
  autonumber
  participant O as Orchestrator
  participant W as Workspace manager (git)
  participant BE as Backend Coding Agent
  participant FE as Frontend Coding Agent
  participant T as Testing Agent
  participant S as Nebius Sandbox
  participant DB as Checkpoint store

  O->>W: create backend + frontend worktrees from last Slice Commit
  par backend
    O->>BE: Task (Slice, API Contract, System Design, Working Memory)
    BE->>W: write files, unit tests
    BE-->>O: done + Working Memory
  and frontend
    O->>FE: Task (Slice, API Contract, UI Spec, extras per Model Capabilities)
    FE->>W: write files, unit tests
    FE-->>O: done + Working Memory
  end
  O->>W: merge workspaces
  O->>DB: Checkpoint
  O->>T: Task: test merged Slice
  T->>S: branch Base Snapshot, upload changed files
  T->>S: run install, unit tests, boot server, smoke tests
  S-->>T: exit codes, logs
  alt all passed
    T-->>O: pass
    O->>W: commit Slice Commit
    O->>DB: Checkpoint (Slice Commit)
  else failures
    T-->>O: Issue Reports (evidence, suspected owner)
    O->>O: resolve Owner, check Retry Budget, Token Budget, Loop
    alt Owner is a Coding Agent and budgets allow
      O->>DB: Checkpoint (retry count, Working Memory)
      O->>BE: retry Task with Issue Report
    else Owner is a design agent
      O->>O: revise document, re-open Design Gate
    else budget exhausted, Loop or undecidable
      O->>O: Escalation
    end
  end
```

## 7. Owner resolution and escalation (activity)

```mermaid
flowchart TD
  A([Issue Report received]) --> L{Same failing test and error<br/>as an earlier report in this Task?}
  L -- yes --> ESC
  L -- no --> B{Code deviates from<br/>API Contract or UI Spec?}
  B -- "backend side" --> BE[Owner: Backend Coding Agent]
  B -- "frontend side" --> FE[Owner: Frontend Coding Agent]
  B -- no --> C{Approved Documents<br/>contradict each other?}
  C -- "UI Spec deviates" --> UD[Owner: UI Design Agent]
  C -- "System Design / API Contract deviates" --> SD[Owner: System Design Agent]
  C -- no --> D{Requirement missing<br/>or wrong?}
  D -- yes --> SD
  D -- no --> ESC

  BE --> R{Retry Budget and<br/>Token Budget left?}
  FE --> R
  R -- yes --> RETRY([Retry Task with Issue Report<br/>+ Working Memory])
  R -- no --> ESC

  UD --> DOC([Revise document<br/>mark dependants Stale<br/>re-open Design Gate])
  SD --> DOC

  ESC{Mode?} -- gated --> H([Pause Run: Escalation<br/>retry with hint · edit documents<br/>skip Slice · abort])
  ESC -- auto --> F([Run Failed<br/>Draft PR with passed Slices<br/>+ failure report])
```

## 8. Code review and PR Gate (sequence)

```mermaid
sequenceDiagram
  autonumber
  actor Dev as Developer
  participant O as Orchestrator
  participant S as Nebius Sandbox
  participant CR as Code Review Agent
  participant C as Coding Agents
  participant G as GitHub
  participant UI as Dashboard / CLI

  O->>S: run ESLint + tsc --strict on final Slice Commits
  S-->>O: linter Findings (Rule IDs)
  O->>CR: review diff vs Review Standard + Approved Documents
  CR-->>O: Findings (Rule ID, severity, location, suggestion)
  alt blocking Findings
    O->>C: fix Task with blocking Findings
    C-->>O: fixed
    O->>O: re-test Slice, re-review
  else no blocking Findings
    O->>G: push run branch, open PR (non-blocking Findings in description)
    G-->>O: PR number
    alt gated
      O-->>UI: PR Gate open
      Dev->>UI: approve or request changes
      UI->>O: decision
      alt approve
        O-->>UI: Run Done (merge stays on GitHub)
      else request changes
        O->>C: fix Task with comments
      end
    else auto
      O-->>UI: Run Done
    end
  end
```

## 9. Resume after restart (sequence)

```mermaid
sequenceDiagram
  autonumber
  participant SRV as Server
  participant DB as Checkpoint store
  participant O as Orchestrator
  participant W as Workspace manager (git)
  participant A as Agent

  SRV->>DB: load unfinished Runs
  DB-->>SRV: latest Checkpoint per Run
  SRV->>O: resume Run from Checkpoint
  O->>DB: mark in-flight Step discarded
  O->>W: reset worktrees to last Slice Commit
  alt Run was waiting at a Gate
    O-->>SRV: Gate still open, wait for human
  else Run was building or reviewing
    O->>A: redo Step with fresh context
    Note over O,A: context = Approved Documents + Task + Issue Reports<br/>+ Working Memory (never the Transcript)
  end
```
