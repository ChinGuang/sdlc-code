# 1. Local git is the source of truth; the sandbox only executes

- Status: Accepted
- Date: 2026-09-17

## Context

Coding Agents need somewhere to write the application while a Run is in progress, and Test Runs must execute that code in isolation. Nebius Token Factory Sandboxes offer Git-like snapshots with branching and rollback, so the sandbox could itself hold the application state: agents write into it, every Step snapshots, failures roll back.

However:

- Backend and Frontend Coding Agents work in parallel within a Slice and their work must be merged.
- The final output is a pull request to the Target Repo.
- Sandbox snapshots preserve files but not running processes or network state, and every file write would be a remote call.
- The sandbox is meant for executing and testing code, not authoring it.

## Decision

- Each Coding Agent writes into its own local git worktree (Workspace). The Orchestrator merges them, and a Slice that passes testing becomes a **Slice Commit**. Slice Commits are the source of truth and the rollback point.
- The sandbox is stateless from the Run's point of view. Each **Test Run** starts from a cached **Base Snapshot** per Stack Profile (template and dependencies installed), receives only the changed code, runs install/tests/boot/smoke tests, and returns results.
- Sandbox branching and rollback are not used to manage application state.

## Consequences

- Merging, rollback and PR delivery use plain git, which is testable and inspectable locally.
- Code is uploaded on every Test Run; the Base Snapshot keeps this cheap.
- A Run depends on the local machine's disk, consistent with the local-first deployment.
- A future cloud deployment must provide persistent storage for worktrees rather than relying on sandbox snapshots.
