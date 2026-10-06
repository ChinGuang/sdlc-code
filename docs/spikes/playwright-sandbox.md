# Spike S1: Playwright in a Nebius sandbox

- **Date:** 2026-10-06
- **Question:** can a browser test run inside a Sandbox, so a Test Run can end by opening the generated app in a real browser?
- **Result:** ✅ Yes. Chromium installs in about half a minute, once, into the Base Snapshot, and a browser test then runs in a second or two.

## What was run

On the image the Base Snapshot is built from (`sdlc-code/node:22`, Debian 12, running as root, network on):

| Step | Result | Time | Cost (credit) |
|---|---|---|---|
| `npm i -D @playwright/test` | 3 packages, `node_modules` 19 MB | 2 s | |
| `npx playwright install --with-deps chromium` | Chrome Headless Shell 153.0.8010.12, **114.3 MiB** download; system libraries from apt worked | 28 s (33 s with the install above) | 0.205 |
| One page test from that image (open a `data:` page, check a heading, click a button, check the title) | passed | 1.2 s of test, 3 s for the run | 0.016 |

The browser lives under `/root/.cache/ms-playwright`, in the image, so a Test Run that starts from the Base Snapshot has it.

## What changed in the platform (S1a)

- The template ships `@playwright/test`, `playwright.config.ts` and one browser test, `e2e/app.spec.ts`: the app opens at `/` without an uncaught error, and `/api/health` answers through the Vite dev server's proxy.
- `scripts/sdlcTest.mjs`: the install step also installs the browser (`--only-shell chromium`; with `--with-deps` only when it builds the Base Snapshot, which is the one run that needs root and apt), and a new **`e2e`** step runs after the API's smoke tests and before the API is stopped. Playwright starts the Vite dev server itself, and its JSON report becomes named failures, like Vitest's.
- `vite.config.ts` proxies `/api` to `process.env.PORT`, which the Test Run sets (3100): it was `3000` written in.
- `TEST_STEPS` gains `e2e`. A failing browser test is an Issue Report. Its own file is the template's spec, which neither Coding Agent may write, so the report takes the application file the failure names instead (the browser's stack, with the dev server's URL and query stripped: `src/screens/TodoScreen.tsx`) and suspects the side that owns it; with no such file it suspects no side and the Orchestrator decides.
- The agents are told the browser test exists and cannot be changed (a template fact); they do **not** write browser tests (a Slice's tests are still Vitest).

## Measured, on the real path

`NEBIUS_LIVE=1 … testRuns.live.test.ts` (three tests, all passing):

- the untouched template passes `install, unit, boot, smoke, e2e, stop`, including a new Base Snapshot build with the browser in it (about 85 s for the whole test, the build being most of it);
- a `src/main.tsx` that throws as it loads passes every unit test and **fails only `e2e`**, with the thrown error in the failure's message;
- a failing unit test still fails alone, as before.

Locally, the e2e step takes about 9 s on a Windows laptop (the Vite start included), and 55 s for the unit step beside it.

## Notes

- `time` is not in the sandbox's `sh`: the spike measured with `date +%s`.
- Processes still do not survive between runs: Playwright's `webServer` starts the dev server and stops it inside the same run, which is what the Test Run needs.
- The Base Snapshot is keyed by a hash of the template, so this change built a new one once (about 0.2 credit for the browser); later Runs reuse it.
- Not done, on purpose: the agents writing browser tests per Slice (S1b). The frontend's Vitest screen tests already cost about 80% of a Run's tokens, and a browser test is slower to write and to fail.
