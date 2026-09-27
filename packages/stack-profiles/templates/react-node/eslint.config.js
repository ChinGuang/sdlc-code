import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * What the Code Review Agent's linter check runs (scripts/sdlcLint.mjs). It is
 * deliberately close to the recommended sets: the Review Standard says what
 * this application must do, and the linter only catches what a tool can see.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".sdlc/**", "prisma/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: "module" },
    },
    rules: {
      // An unused local is a LINT-01 Finding; an argument named on purpose
      // (a handler's event) is not, so a leading underscore excuses it.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
);
