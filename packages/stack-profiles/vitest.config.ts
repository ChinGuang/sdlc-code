import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "stack-profiles", include: ["src/**/*.test.ts"] },
});
