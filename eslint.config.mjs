import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

// Shared no-restricted-syntax selectors. Flat config REPLACES a rule wholesale
// per matching file, so scoped blocks must re-list every selector they keep —
// hence these arrays instead of inline literals.
const baseRestrictedSyntax = [
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
]

// App-layer-only additions (UI code). Property-level (not JSXAttribute-descendant)
// on purpose: this codebase hoists style objects into module consts
// (TraderRowStyles.ts pattern), which a style={{...}}-scoped selector would miss.
// Known benign false positive: string literals with URL fragments like '/p#a1b2c3'
// — use an eslint-disable-next-line comment (see docs/LINTING_GUIDE.md).
const appRestrictedSyntax = [
  {
    selector: "Property[value.type='Literal'][value.value=/#[0-9a-fA-F]{3,8}\\b/]",
    message:
      'Raw hex color. Use tokens.colors.* or a --color-* CSS variable so theming stays intact. See DESIGN.md.',
  },
  {
    selector: 'TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}\\b/]',
    message:
      'Raw hex color in template string. Use tokens.colors.* or var(--color-*). See DESIGN.md.',
  },
  {
    selector:
      "LogicalExpression[operator='||'][left.type='CallExpression'][left.callee.name='t'][right.type='Literal'][right.value=/[\\u4e00-\\u9fff]/]",
    message:
      't() never returns a falsy value — the Chinese fallback is dead code (and leaks zh to other locales when a translation is an empty string). Add the key to lib/i18n locales instead.',
  },
]

// Warn-everywhere additions NOT yet in the ratchet (legacy volume too high to
// lock): raw rgb()/rgba() literals bypass the hex selectors, and
// `language === 'zh' ?` ternaries bypass the isZh rule. Guard new code now;
// burn down the backlog before promoting these into the ratchet arrays.
const appWarnOnlySyntax = [
  {
    selector: "Property[value.type='Literal'][value.value=/rgba?\\(\\s*[0-9]/]",
    message:
      'Raw rgb()/rgba() color. Use a --color-* CSS variable or color-mix(in srgb, var(--x) n%, transparent). See DESIGN.md.',
  },
  {
    selector: 'TemplateElement[value.raw=/rgba?\\(\\s*[0-9]/]',
    message:
      'Raw rgb()/rgba() in template string. Use var(--color-*) or color-mix(). See DESIGN.md.',
  },
  {
    selector:
      "ConditionalExpression > BinaryExpression[operator='==='][left.name='language'][right.value='zh']",
    message:
      "Do not branch copy on language === 'zh' — ja/ko users get the English fallback. Use t('key') with keys in all 4 locales.",
  },
]

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
      'no-restricted-syntax': ['warn', ...baseRestrictedSyntax],
    },
  },
  // ============================================
  // App-layer design-token + i18n guardrails (warn-level ratchet entry point)
  // Cleaned files get escalated to 'error' in the ratchet block below.
  // ============================================
  {
    files: ['app/**/*.tsx', 'app/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        ...baseRestrictedSyntax,
        ...appRestrictedSyntax,
        ...appWarnOnlySyntax,
      ],
    },
  },
  // ============================================
  // RATCHET: files cleaned of design-token violations lock at error level.
  // Add every newly-cleaned file here — it must never regress.
  // End state: whole app/ tree in this list, warn block above deleted.
  // See docs/LINTING_GUIDE.md "The ratchet".
  // ============================================
  {
    files: [
      'app/error.tsx',
      'app/global-error.tsx',
      'app/components/ui/ProBadge.tsx',
      'app/components/ui/DataStateWrapper.tsx',
      'app/components/ui/ReportModal.tsx',
      'app/components/settings/WalletSection.tsx',
      'app/components/sidebar/TrendingHashtags.tsx',
      'app/components/sidebar/RecommendedGroups.tsx',
      'app/components/auth/LoginModal.tsx',
      'app/components/market/LiveTradesFeed.tsx',
      'app/components/market/TokenSidePanel.tsx',
      'app/components/portfolio/PortfolioAnalytics.tsx',
      'app/components/post/PostDetailModal.tsx',
      'app/components/profile/MobileProfileMenu.tsx',
      'app/components/ranking/RankingFilters.tsx',
      'app/components/post/components/PostDetailView.tsx',
      'app/components/trader/AdvancedMetricsCard.tsx',
      'app/components/trader/MarketCorrelationCard.tsx',
      'app/components/trader/CopyTradeSimulator.tsx',
      'app/components/home/RankingControls.tsx',
      'app/components/onboarding/WelcomeModal.tsx',
      'app/components/market/DefiOverview.tsx',
      'app/components/utils/ErrorBoundary.tsx',
      'app/components/home/SSRRankingTable.tsx',
      'app/components/home/HomeHeroSSR.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...baseRestrictedSyntax, ...appRestrictedSyntax],
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
