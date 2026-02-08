import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // ============================================
  // Project-specific rules
  // See docs/LINTING_GUIDE.md for rationale
  // ============================================
  {
    rules: {
      // ----------------------------------------
      // Disabled rules (legacy patterns)
      // ----------------------------------------
      // This repo contains many pragmatic uses of `any` across UI + scripts.
      "@typescript-eslint/no-explicit-any": "off",

      // Allow unused vars with _ prefix (common pattern for intentionally unused params)
      "@typescript-eslint/no-unused-vars": ["warn", {
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_"
      }],

      // These rules are helpful, but currently too strict for the codebase patterns.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",

      // Next link rule is nice-to-have; we allow <a> in simple 404 pages.
      "@next/next/no-html-link-for-pages": "off",
      "@next/next/no-img-element": "off",

      // ----------------------------------------
      // Warnings (non-blocking, for gradual improvement)
      // ----------------------------------------
      // Prefer const is fine as warning (autofixable), not a deploy blocker.
      "prefer-const": "warn",

      // Encourage use of === over == (catches type coercion bugs)
      "eqeqeq": ["warn", "always", { "null": "ignore" }],

      // Warn on console.log (should use logger utility)
      "no-console": ["warn", { "allow": ["warn", "error"] }],

      // Warn on unused variables (helps catch dead code)
      "@typescript-eslint/no-unused-vars": ["warn", {
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_"
      }],

      // Warn on empty catch blocks (should at least log)
      "no-empty": ["warn", { "allowEmptyCatch": false }],

      // Encourage async/await error handling
      "no-async-promise-executor": "warn",
    },
  },
  // ============================================
  // System State Management enforcement
  // See docs/system-principles.md for rationale
  // ============================================
  {
    files: ["app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["warn",
        {
          "selector": "MemberExpression[object.property.name='auth'][property.name='getSession']",
          "message": "Use useAuthSession() hook instead of direct supabase.auth.getSession(). See docs/system-principles.md"
        },
        {
          "selector": "MemberExpression[object.property.name='auth'][property.name='getUser']",
          "message": "Use useAuthSession() hook instead of direct supabase.auth.getUser(). See docs/system-principles.md"
        },
        {
          "selector": "MemberExpression[object.property.name='auth'][property.name='onAuthStateChange']",
          "message": "Use useAuthSession() hook instead of direct supabase.auth.onAuthStateChange(). See docs/system-principles.md"
        },
      ],
    },
  },
  // Exempt: auth hook implementation and server-side API routes (which use JWT verification)
  {
    files: ["lib/hooks/useAuthSession.ts", "app/api/**/*.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Tooling / docs / vendor - don't block app lint
    "scripts/**",
    "docs/**",
    "public/**/*.mjs",
    "worker/**",
    ".archived/**",
    // Claude skills (external, not part of project)
    ".claude/**",
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
