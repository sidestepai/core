import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "test/fixtures/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
      // TypeScript itself checks for undefined identifiers (incl. Node globals);
      // eslint's no-undef is redundant here and produces false positives.
      "no-undef": "off",
      // Core `no-redeclare` flags TS function overload signatures as redeclares;
      // the TS-aware rule understands them. Swap to it.
      "no-redeclare": "off",
      "@typescript-eslint/no-redeclare": "error",
    },
  },
];
