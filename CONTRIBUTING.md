# Contributing to Ranking Arena

## Getting Started

1. Fork and clone the repo
2. `npm install`
3. Copy `.env.example` to `.env.local` and fill in values
4. `npm run dev`

## Code Style

- **TypeScript** strict mode — no `any` unless absolutely necessary
- **Tailwind CSS** for styling, use design tokens from `lib/design-tokens.ts`
- **ESLint + Prettier** — run `npm run lint:fix && npm run format` before committing
- **Server Components** by default; add `'use client'` only when needed
- **Zod** for all API input validation

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

feat:     New feature
fix:      Bug fix
perf:     Performance improvement
refactor: Code change (no feature/fix)
test:     Adding/updating tests
docs:     Documentation only
chore:    Build, CI, tooling
a11y:     Accessibility
seo:      SEO improvements
i18n:     Internationalization
```

Examples:
- `feat(rankings): add ROI filter for 90D period`
- `fix(auth): handle expired Supabase session`
- `perf: lazy load web3 wallet components`

## Pull Request Process

1. Create a feature branch from `main`: `git checkout -b feat/my-feature`
2. Make changes, ensure all checks pass:
   ```bash
   npm run type-check
   npm run lint
   npm run test
   npm run build
   ```
3. Open PR against `main` with a clear description
4. At least 1 review required before merge
5. Squash merge preferred

## Testing

- **Unit tests**: `npm run test` (Jest + Testing Library)
- **E2E tests**: `npm run test:e2e` (Playwright)
- New features should include tests
- Aim for meaningful coverage, not 100%

## Project Conventions

- API routes in `app/api/` — use `lib/api/` helpers for consistent responses
- Database queries through `lib/supabase/` — never direct SQL in components
- Rate limiting via `lib/ratelimit/`
- All user-facing text should support i18n (`lib/i18n/`)

## Questions?

Open an issue or check `docs/` for architecture and API docs.
