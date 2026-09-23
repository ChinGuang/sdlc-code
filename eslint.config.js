// ESLint flat config. The "no-restricted-syntax" rules enforce CODING_STANDARDS.md;
// tests/codingStandards.test.ts proves they fire.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Template apps are shipped to generated projects, not built here.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "docs/**",
      "packages/stack-profiles/templates/**",
      // Applications a Run built, and Claude Code's worktrees: not this repo's code.
      ".sdlc-runs/**",
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: [
            "PropertyDefinition",
            "MethodDefinition",
            "AccessorProperty",
            "TSAbstractPropertyDefinition",
            "TSAbstractMethodDefinition",
            "TSAbstractAccessorProperty",
          ]
            .map((node) => `${node}[accessibility='private']`)
            .join(", "),
          message:
            "SC-2: use JavaScript #private members, not the TypeScript `private` keyword.",
        },
        {
          selector: "TSParameterProperty",
          message:
            "SC-2: no parameter properties; declare the field and assign it in the constructor body.",
        },
        {
          // Direct methods only (`> ClassBody >`), so nested helper classes are not flagged.
          // NestJS @Controller classes are exempt: route handlers are decorated methods.
          selector: ["ClassDeclaration", "ClassExpression"]
            .map(
              (node) =>
                `${node}[implements.length>0]:not(:has(> Decorator[expression.callee.name='Controller'])) > ClassBody > MethodDefinition[kind='method'][static=false]:not([key.type='PrivateIdentifier']):not([accessibility='protected']):not([accessibility='private'])`,
            )
            .join(", "),
          message:
            "SC-3: public methods of a service/client must be arrow-function properties (e.g. `run = async () => {}`).",
        },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
  },
);
