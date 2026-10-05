// SPDX-License-Identifier: MPL-2.0
import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "cli", include: ["src/**/*.test.ts"] },
});
