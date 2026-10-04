import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { verifyStubs } from "./testing/stubApi.js";

// Vitest runs without `globals`, so Testing Library never registers its own
// cleanup: without this, a second render() leaves the first screen mounted and
// every query by role matches two elements. Seen live: three Coding Agent
// attempts rewrote a correct screen chasing "found multiple elements".
afterEach(cleanup);

// A test that stubs fetch (stubApi, vi.stubGlobal) must not leave the stub for
// the next one; and a request nothing stubbed fails the test that made it, even
// when the screen caught the error and showed its own.
afterEach(() => {
  vi.unstubAllGlobals();
  verifyStubs();
});
