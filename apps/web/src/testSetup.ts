// SPDX-License-Identifier: MPL-2.0
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs without `globals`, so Testing Library never registers its own
// cleanup: without this, one test's screen is still mounted in the next.
afterEach(cleanup);
