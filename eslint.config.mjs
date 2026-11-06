import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import astro from "eslint-plugin-astro";
import importX from "eslint-plugin-import-x";
import globals from "globals";
import tseslint from "typescript-eslint";

const sourceFiles = ["**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,astro}"];
const restricted = (regex) => [
  "error",
  {
    patterns: [
      {
        regex,
        message: "Keep websites and the engine separate; use the public API.",
      },
    ],
  },
];

export default defineConfig(
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/.astro/**",
    ".generated/**",
    "coverage/**",
    "test-results/**",
    "playwright-report/**",
    "fixtures/**",
    "packages/client/src/generated.ts",
  ]),
  {
    files: sourceFiles,
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    plugins: { "import-x": importX },
    settings: {
      "import-x/resolver": {
        node: { extensions: [".js", ".mjs", ".ts", ".astro"] },
      },
    },
    rules: {
      "max-statements-per-line": ["error", { max: 1 }],
      "import-x/no-relative-packages": "error",
    },
  },
  ...astro.configs["flat/recommended"],
  {
    files: ["**/*.astro"],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    files: ["examples/**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,astro}"],
    rules: {
      "no-restricted-imports": restricted(
        "(^|/)packages/engine(/|$)|^@idx-kit/engine(/|$)",
      ),
    },
  },
  {
    files: ["packages/**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,astro}"],
    rules: {
      "no-restricted-imports": restricted(
        "(^|/)examples(/|$)|^@idx-kit/demo-site(/|$)",
      ),
    },
  },
);
