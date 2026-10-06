import { defineConfig } from "@playwright/test";

/**
 * The browser tests (e2e/). A Test Run (scripts/sdlcTest.mjs) boots the API on
 * PORT, then runs these: the Vite dev server below proxies /api to it, as it
 * does for a person running `npm run dev`. To run them by hand, start the API
 * first (`npm run dev:api`) and then `npm run test:e2e`.
 */
const WEB_PORT = 5199;
const baseURL = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  // One browser, one worker: the tests share the API and its database.
  workers: 1,
  retries: 0,
  reporter: [["line"], ["json", { outputFile: ".sdlc/playwright.json" }]],
  use: { baseURL },
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
