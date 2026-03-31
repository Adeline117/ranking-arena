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
      // Off: 71 legacy `any` annotations produce noise. TypeScript strict mode + code review catch new ones.
      "@typescript-eslint/no-explicit-any": "off",

      // These rules are helpful, but currently too strict for the codebase patterns.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",

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

      // Ban console.log in production code (use logger utility)
      "no-console": ["error", { "allow": ["warn", "error"] }],

      // Warn on unused variables (helps catch dead code)
      "@typescript-eslint/no-unused-vars": ["warn", {
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_"
      }],

      // Ban empty catch blocks (must at least log or comment)
      "no-empty": ["error", { "allowEmptyCatch": false }],

      // Encourage async/await error handling
      "no-async-promise-executor": "warn",

      // Detect empty Promise .catch() callbacks like .catch(() => {})
      // Use fireAndForget() from lib/utils/logger instead for proper logging
      "no-restricted-syntax": ["warn",
        {
          "selector": "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='BlockStatement'][body.body.length=0]",
          "message": "Empty .catch(() => {}) silently swallows errors. Use fireAndForget() from lib/utils/logger instead."
        },
        {
          "selector": "ConditionalExpression[test.name='isZh']",
          "message": "Do not use isZh ? ternary for translations. Use t('key') from useLanguage() instead. See lib/i18n."
        },
      ],
    },
  },
  // ============================================
  // System State Management enforcement
  // See docs/system-principles.md for rationale
  // ============================================
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
    "infra/**",
    // E2E tests (console.log for test output is acceptable)
    "e2e/**",
    // Test files
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.spec.ts",
    "**/*.spec.tsx",
    // Claude skills (external, not part of project)
    ".claude/**",
    // Build artifacts (Vercel output, Playwright reports)
    ".vercel/**",
    "playwright-report/**",
    "dist/**",
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
