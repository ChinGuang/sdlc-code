// ESLint flat config. The "no-restricted-syntax" rules enforce CODING_STANDARDS.md;
// tests/codingStandards.test.ts proves they fire.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["spikes/**", "**/dist/**", "**/node_modules/**", "docs/**"] },
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
          selector:
            "PropertyDefinition[accessibility='private'], MethodDefinition[accessibility='private']",
          message:
            "SC-2: use JavaScript #private members, not the TypeScript `private` keyword.",
        },
        {
          selector: "TSParameterProperty",
          message:
            "SC-2: no parameter properties; declare the field and assign it in the constructor body.",
        },
        {
          selector:
            "ClassDeclaration[implements.length>0] MethodDefinition[kind='method'][static=false]:not([key.type='PrivateIdentifier'])",
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
