import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

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
      '@typescript-eslint/no-explicit-any': 'off',

      // These rules are helpful, but currently too strict for the codebase patterns.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',

      // Next link rule is nice-to-have; we allow <a> in simple 404 pages.
      '@next/next/no-html-link-for-pages': 'off',
      '@next/next/no-img-element': 'off',

      // ----------------------------------------
      // Warnings (non-blocking, for gradual improvement)
      // ----------------------------------------
      // Prefer const is fine as warning (autofixable), not a deploy blocker.
      'prefer-const': 'warn',

      // Encourage use of === over == (catches type coercion bugs)
      eqeqeq: ['warn', 'always', { null: 'ignore' }],

      // Ban console.log in production code (use logger utility)
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // Warn on unused variables (helps catch dead code)
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Ban empty catch blocks (must at least log or comment)
      'no-empty': ['error', { allowEmptyCatch: false }],

      // Encourage async/await error handling
      'no-async-promise-executor': 'warn',

      // Detect empty Promise .catch() callbacks like .catch(() => {})
      // Use fireAndForget() from lib/utils/logger instead for proper logging
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='BlockStatement'][body.body.length=0]",
          message:
            'Empty .catch(() => {}) silently swallows errors. Use fireAndForget() from lib/utils/logger instead.',
        },
        {
          selector: "ConditionalExpression[test.name='isZh']",
          message:
            "Do not use isZh ? ternary for translations. Use t('key') from useLanguage() instead. See lib/i18n.",
        },
        // ── Design token enforcement ──
        // Prevent hardcoded fontSize (use tokens.typography.fontSize.*)
        {
          selector: "Property[key.name='fontSize'][value.type='Literal'][value.raw=/^[0-9]/]",
          message:
            'Hardcoded fontSize. Use tokens.typography.fontSize.* (xs=12, sm=13, base=14, md=16, lg=18, xl=20, 2xl=24, hero=28). See DESIGN.md.',
        },
        // Prevent hardcoded borderRadius (use tokens.radius.*)
        {
          selector: "Property[key.name='borderRadius'][value.type='Literal'][value.raw=/^[0-9]/]",
          message:
            'Hardcoded borderRadius. Use tokens.radius.* (sm=6, md=10, lg=14, xl=18, full=9999). See DESIGN.md.',
        },
        // Prevent hardcoded fontWeight (use tokens.typography.fontWeight.*)
        {
          selector: "Property[key.name='fontWeight'][value.type='Literal'][value.raw=/^[0-9]/]",
          message:
            'Hardcoded fontWeight. Use tokens.typography.fontWeight.* (normal=400, medium=500, semibold=600, bold=700, black=900). See DESIGN.md.',
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
    files: ['lib/hooks/useAuthSession.ts', 'app/api/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  // ============================================
  // Ingest framework boundary (ARENA_DATA_SPEC §2.1)
  // app/** may import lib/ingest contracts (core/*, fetch/types) but never
  // the Playwright-touching implementations or the direct-PG pool — those
  // are worker-only and would break the Vercel bundle.
  // ============================================
  {
    files: ['app/**/*.ts', 'app/**/*.tsx', 'lib/data/**/*.ts', 'lib/hooks/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/lib/ingest/fetch/fetcher',
                '@/lib/ingest/fetch/capture',
                '@/lib/ingest/db',
                '@/lib/ingest/raw',
                '@/lib/ingest/adapters/*',
                '**/lib/ingest/fetch/fetcher',
                '**/lib/ingest/fetch/capture',
                '**/lib/ingest/db',
                '**/lib/ingest/raw',
              ],
              message:
                'Worker-only ingest module (Playwright/pg). app code may only import lib/ingest/core/* and lib/ingest/fetch/types.',
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Tooling / docs / vendor - don't block app lint
    'scripts/**',
    'docs/**',
    'public/**/*.mjs',
    'worker/**',
    '.archived/**',
    'infra/**',
    // E2E tests (console.log for test output is acceptable)
    'e2e/**',
    // Test files
    '**/*.test.ts',
    '**/*.test.tsx',
    '**/*.spec.ts',
    '**/*.spec.tsx',
    // Claude skills (external, not part of project)
    '.claude/**',
    // Build artifacts (Vercel output, Playwright reports)
    '.vercel/**',
    'playwright-report/**',
    'dist/**',
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
  ]),
])

export default eslintConfig
