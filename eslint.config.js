import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // Global ignores — match the original .eslintrc.json ignorePatterns
  {
    ignores: ["dist/**", "node_modules/**", "src-tauri/target/**"],
  },

  // Scope to TypeScript/TSX only — preserves the original `--ext .ts,.tsx` intent.
  // All rule configs below inherit this files filter.
  {
    files: ["**/*.{ts,tsx}"],

    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      // eslint-plugin-react flat config — version pinned to avoid
      // the removed context.getFilename() call in ESLint 10.
      reactPlugin.configs.flat.recommended,
      // react-hooks v7 flat config (only the 'recommended' sub-config)
      reactHooks.configs.flat["recommended"],
    ],

    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },

    settings: {
      // Pin explicit version — eslint-plugin-react's "detect" calls the
      // removed context.getFilename() API (removed in ESLint 10).
      react: { version: "19" },
    },

    rules: {
      // ── Preserved from original .eslintrc.json ─────────────────────────
      // React 17+ JSX transform — no React import needed
      "react/react-in-jsx-scope": "off",
      // TypeScript covers prop-types
      "react/prop-types": "off",
      // Warn on unused vars; ignore underscore-prefixed args
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // ── Downgraded: noisy/new rules not present in original config ──────
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "react/display-name": "warn",
      // react/no-unescaped-entities: purely cosmetic in JSX string literals
      "react/no-unescaped-entities": "warn",
      // react-hooks v7 new strict rules — not present in the original
      // eslint-plugin-react-hooks@^4 recommended set; downgrade to warn
      // so pre-existing code doesn't block CI until it can be reviewed.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/use-memo": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/globals": "warn",
      "react-hooks/error-boundaries": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-render": "warn",
      "react-hooks/gating": "warn",
      "react-hooks/config": "warn",
      // no-control-regex: intentional pattern in supabase security util
      "no-control-regex": "warn",
      // preserve-caught-error: new ESLint 10 rule; pre-existing code
      // doesn't chain causes — downgrade until codebase adopts the pattern.
      "preserve-caught-error": "warn",
    },
  },
);

