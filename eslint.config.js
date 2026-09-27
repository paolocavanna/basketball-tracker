import js from "@eslint/js";
import globals from "globals";
import vue from "eslint-plugin-vue";

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
  // "essential" keeps only Vue correctness rules, so nothing fights Prettier.
  ...vue.configs["flat/essential"],
  {
    files: ["**/*.js", "**/*.mjs", "**/*.vue"],
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
  // Node: schema setup script, the test runner, and the local API the dev
  // server mounts in place of the Pages Functions.
  {
    files: ["scripts/**/*.mjs", "tests/**/*.mjs", "eslint.config.js", "frontend/dev/**/*.js"],
    languageOptions: { globals: globals.node },
  },
  // Cloudflare Pages Functions and the shared lib/ helpers run on the workers
  // runtime, which also exposes the standard Request/Response globals.
  {
    files: ["functions/**/*.js", "lib/**/*.js"],
    languageOptions: { globals: { ...globals.worker, ...globals.node } },
  },
  // Browser: the Vue app plus the local-first store and sync modules.
  {
    files: ["frontend/src/**/*.js", "frontend/src/**/*.vue", "frontend/*.js"],
    languageOptions: { globals: globals.browser },
  },
];
