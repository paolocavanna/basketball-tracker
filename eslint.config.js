import js from "@eslint/js";
import globals from "globals";
import vue from "eslint-plugin-vue";
import tseslint from "typescript-eslint";

// Baseline only: correctness rules, no stylistic rules. Formatting is
// Prettier's job (see .prettierrc), so no formatting rules are enabled here.
export default [
  {
    ignores: [
      "**/node_modules/**",
      "frontend/dist/**",
      ".wrangler/**",
      ".tokensave/**",
      "**/.vscode/**",
      "auth",
      "auth-wal",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // "essential" keeps only Vue correctness rules, so nothing fights Prettier.
  ...vue.configs["flat/essential"],
  {
    files: ["**/*.js", "**/*.ts", "**/*.vue"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.ts", "**/*.vue"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  // Node: schema setup script, the test runner, and the local API the dev
  // server mounts in place of the Pages Functions.
  {
    files: [
      "scripts/**/*.ts",
      "tests/**/*.ts",
      "eslint.config.js",
      "frontend/dev/**/*.ts",
      "frontend/vite.config.ts",
    ],
    languageOptions: { globals: globals.node },
  },
  // Cloudflare Pages Functions and the shared lib/ helpers run on the workers
  // runtime, which also exposes the standard Request/Response globals.
  {
    files: ["functions/**/*.ts", "lib/**/*.ts"],
    languageOptions: { globals: { ...globals.worker, ...globals.node } },
  },
  // Browser: the Vue app plus the local-first store and sync modules.
  {
    files: ["frontend/src/**/*.ts", "frontend/src/**/*.vue", "frontend/*.ts"],
    languageOptions: { globals: globals.browser },
  },
];
