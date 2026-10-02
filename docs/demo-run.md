# T25: the first end-to-end demo Run

A gated Run of the todo app, from request to a pull request on GitHub. It was
the first Run of the whole pipeline, and it is the record the README and the
demo video draw on.

- **Request:** "A todo app where a person can add a todo with a title, see the
  list, mark a todo done or not done, and delete it."
- **Target Repo:** `ChinGuang/sdlc-code-demo-todo` (empty before the Run)
- **Run:** `c4bce5a2` · gated · Token Budget 8M, raised to 12M and then 13.5M
- **Result:** Draft PR [#1](https://github.com/ChinGuang/sdlc-code-demo-todo/pull/1),
  19 files, +1,377 lines. Five Slices built and tested; the Run was aborted at
  its last Token Budget Escalation, because Code Review kept sending the last
  Slice back on findings that were mostly false (see below).

## Timings

| Stage | Time | Tokens |
|---|---|---|
| Design (System Design, Slice Plan, API Contract, UI Spec, Penpot design, 5 screenshots) | 2 min 2 s (07:27:23 to 07:29:25 UTC) | 35k |
| Design Gate | approved at 07:31 UTC (me, after reading the documents) | 0 |
| Coding Steps, all five Slices (backend + frontend) | about 77 min of agent time | 13.18M |
| Code Review (2 reviews) and the Orchestrator's own calls | minutes | about 0.3M |
| **Total** | 7 h 05 min wall clock, of which the Run was waiting on a person for most | **13.51M** |

Wall clock is mostly waiting: each Escalation needed a person, and most of
them were answered after fixing the platform.

### Tokens by Slice and agent

| Slice | Backend | Frontend | Steps (backend / frontend) |
|---|---|---|---|
| Walking Skeleton | 1.01M | 0.65M | 4 / 2 |
| List Todos | 0.76M | 0.13M | 2 / 1 |
| Create Todo | 0.09M | **4.75M** | 1 / 6 |
| Update Todo | 0.17M | **3.41M** | 2 / 6 |
| Delete Todo | 0.41M | 1.78M | 3 / 6 |
| **Total** | **2.45M (19%)** | **10.73M (79%)** | |

The Frontend Coding Agent spent four in five tokens, and two screens (Create
and Update) spent 8.2M of that fighting their own tests.

## Escalations (7)

| # | At | Trigger | What it was | Answered |
|---|---|---|---|---|
| 1 | Walking Skeleton | loop | The API could not boot: the sandbox image had no OpenSSL (platform bug) | retry, after the fix |
| 2 | Create Todo | loop | A test imported `@testing-library/jest-dom`, which needs a global `expect` | retry with a hint, frontend only |
| 3 | Update Todo | Token Budget | 8M spent | raised to 12M |
| 4 | Update Todo | loop | A screen using route params was tested without its route | retry with a hint, frontend only |
| 5 | Delete Todo | Token Budget | 12M spent | raised to 13.5M |
| 6 | Delete Todo | loop | Code Review's false findings, then agents rightly changing nothing | retry |
| 7 | Delete Todo | Token Budget | 13.5M spent | aborted, with a Draft PR |

## What T24c to T24j did, live

- **T24h** kept the escalated Run's code across every server restart (five, to apply fixes between Escalations).
- **T24i** retried the frontend alone for every frontend problem: the backend
  never ran for them.
- **T24d** kept the API Contract's `/health` right and the agents off the
  template's files; **T24j** gave a cheap check that now names a line.
- **T24c** wrote a brief for every Escalation. Its facts were right; its
  analysis was misleading at least twice: for #1 it blamed the System Design and
  suggested editing the documents, and for #2 it suggested a hint that kept
  the import that caused the error.

## Bugs the Run found (all fixed on `chore/t25-demo-run`)

1. **An empty Target Repo had no base branch.** Delivery now begins it at the
   Run's start commit (the template), then pushes the Run's branch. GitHub says
   404 for a missing branch and 409 ("Git Repository is empty") for an empty
   repository; both are handled.
2. **The sandbox image had no OpenSSL**, so Prisma's engine could not start and
   the Walking Skeleton's API never booted. The Base Snapshot is built on
   `node:22`, not `node:22-slim`.
3. **A test imported jest-dom directly.** A frontend fact and a cheap check.
4. **A screen reading route params was tested without its `<Route>`.** A
   frontend fact.
5. **The lint typechecked without generating the Prisma client**, so every
   model a Slice added read as missing: 14 false blocking Findings.
6. **Unchanged code counted as a Loop before any Test Run had failed**, after an
   attempt that stopped before testing.
7. **A Draft PR that failed to push could not be retried.** Aborting an
   aborted Run whose pull request never opened now retries it.

## Found, not fixed (follow-ups)

- **Code Review sends passing code back on invented findings.** Beyond the
  false lint findings: the Code Review Agent reported "component is
  incomplete, missing imports" for complete files, and `submit_findings` (at
  most 5 per call) failed repeatedly, so it kept resubmitting. Only the
  linter's findings can be checked; the agent's cannot, yet they block.
- **The dashboard keeps showing a Run as it was before a server restart** until
  the page is reloaded.
- **The Draft PR says a Slice is "not included" when its commit is pushed.** A
  Slice that passed and was then sent back by the review is re-opened, but its
  commit stays on the run branch.
- **The Escalation Brief did not know the template facts**, so it sometimes
  suggested hints that contradict them.
- **Frontend screen tests cost 80% of the tokens.** The agents have a template
  test and facts to copy, but form screens (typing, submit, navigate) and
  screens with params have no example.

## What the PR holds

Draft PR #1 contains the Walking Skeleton, List Todos, Create Todo, Update Todo
and Delete Todo Slices on top of the template (`main`, begun by the Run). It is
a Draft because the Run was aborted at an Escalation: no PR Gate was reached.
A clean Run (all of the above fixed) is the one to show in the demo video.
