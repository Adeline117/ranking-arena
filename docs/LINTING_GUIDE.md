# Linting Guide

Rationale for project-specific ESLint rules in `eslint.config.mjs`.

## Design-token enforcement (`no-restricted-syntax`)

Arena has a complete token system (`lib/design-tokens.ts` + `DESIGN.md`) but ~7.5K
inline style blocks predate it. These rules stop NEW drift without blocking CI on
the legacy backlog.

### Rules

| Scope    | Selector catches                                    | Fix                                               |
| -------- | --------------------------------------------------- | ------------------------------------------------- |
| global   | `fontSize: 13` style property                       | `tokens.typography.fontSize.sm`                   |
| global   | `borderRadius: 6`                                   | `tokens.radius.sm`                                |
| global   | `fontWeight: 700`                                   | `tokens.typography.fontWeight.bold`               |
| `app/**` | `color: '#7c5cff'` (raw hex in any object property) | `tokens.colors.*` or `var(--color-*)`             |
| `app/**` | `` `1px solid #333` `` (hex in template string)     | `var(--color-border-*)`                           |
| `app/**` | `t('key') \|\| '中文'`                              | delete the fallback; add the key to all 4 locales |

The hex selectors are **Property-level**, not `style={{...}}`-descendant — this
codebase hoists style objects into module consts (`TraderRowStyles.ts` pattern)
which a JSX-scoped selector would miss.

### Why `t('key') || '中文'` is dead code

Both `t()` implementations (`lib/i18n.ts`, `LanguageProvider.tsx`) fall back
lang → en → **the key string itself**, which is truthy. The Chinese literal only
fires when a translation value is the empty string — in which case non-zh users
see raw Chinese. Always fix the locale files, never the call site.

### Escape hatch

False positives (e.g. a URL fragment `'/page#a1b2c3'`) get a targeted disable:

```ts
// eslint-disable-next-line no-restricted-syntax -- URL fragment, not a color
const href = '/changelog#4f9a2b'
```

## The ratchet

All token rules are **warn** by default. When a file is fully cleaned, add it to
the ratchet block at the bottom of `eslint.config.mjs` (files list with the same
selectors at **error** level) so it can never regress. The end state is the whole
`app/` tree in the ratchet and the warn block deleted.

Do NOT add `--max-warnings 0` to the lint script until the warning baseline is
zero — there are thousands of legacy warnings by design.

## Other rules

- **Empty `.catch(() => {})`** — swallows errors; use `fireAndForget()` from
  `lib/utils/logger`.
- **`isZh ?` ternaries** — use `t('key')`; ternaries bypass ja/ko locales.
- **`no-console`** (error, allows warn/error) — use the logger utility.
- **Ingest import boundary** — `app/**` may import `lib/ingest/core/*` and
  `lib/ingest/fetch/types` only; fetcher/capture/db/raw are worker-only
  (Playwright + direct PG would break the Vercel bundle).
