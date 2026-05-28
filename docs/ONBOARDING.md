# Onboarding Guide

Welcome to Arena. This doc gets you from zero to productive.

## 1. Environment Setup

### Prerequisites

- Node.js 20+
- npm 10+
- Git
- A code editor (VS Code recommended, see `.vscode/` for settings)

### Steps

```bash
# Clone
git clone git@github.com:Adeline117/ranking-arena.git
cd ranking-arena

# Install dependencies
npm install

# Copy env template and fill in values (ask Adeline for the actual values)
cp .env.example .env.local

# Start dev server
npm run dev
# App runs at http://localhost:3000
```

### Minimum .env.local to run locally

You don't need all 190 env vars. These are the essentials:

```bash
# Must have — app won't start without these
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
CRON_SECRET=...

# Payments (use Stripe test keys)
STRIPE_SECRET_KEY=sk_test_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Nice to have
SENTRY_DSN=...                  # Error tracking
TELEGRAM_BOT_TOKEN=...          # Pipeline alerts
```

Ask Adeline for the actual values — never commit `.env.local`.

### Dev server notes

- Turbopack is used by default (`npm run dev`)
- Dev server needs ~3.5GB memory (already configured in npm scripts)
- First load is slow; subsequent loads are fast

---

## 2. Accounts & Access

Ask Adeline to add you to:

| Service      | What you need                              | Why                                |
| ------------ | ------------------------------------------ | ---------------------------------- |
| **GitHub**   | Collaborator on `Adeline117/ranking-arena` | Push branches, open PRs            |
| **Vercel**   | Team member                                | See deployments, logs, env vars    |
| **Supabase** | Project member                             | DB access, run queries, check logs |
| **Sentry**   | Project member                             | View errors and performance        |
| **Upstash**  | Read access                                | Check Redis cache and rate limits  |
| **Stripe**   | Test mode access                           | Test payment flows                 |

---

## 3. Reading Order

Read these in order. Budget ~2 hours total.

### Day 1 (must read)

| Order | File                   | Time   | What you learn                                                      |
| ----- | ---------------------- | ------ | ------------------------------------------------------------------- |
| 1     | `CLAUDE.md`            | 30 min | Everything: architecture, conventions, commands, mandatory patterns |
| 2     | `CONTRIBUTING.md`      | 5 min  | Code style, commit format, PR process                               |
| 3     | `docs/GIT_WORKFLOW.md` | 5 min  | Branch strategy, how we collaborate                                 |
| 4     | `PROGRESS.md`          | 10 min | What happened recently, current state                               |
| 5     | `TASKS.md`             | 10 min | What needs to be done, priorities                                   |

### First week (read when relevant)

| File                              | When to read                                |
| --------------------------------- | ------------------------------------------- |
| `DECISIONS.md`                    | When you wonder "why is it built this way?" |
| `docs/RUNBOOK.md`                 | Before you touch anything in production     |
| `docs/SCRAPER.md`                 | Before touching data pipeline or connectors |
| `docs/API_BEST_PRACTICES.md`      | Before writing a new API route              |
| `docs/RLS_POLICIES.md`            | Before touching database tables             |
| `docs/SECURITY_BEST_PRACTICES.md` | Before touching auth, payment, or user data |
| `docs/system-principles.md`       | Before building UI with state management    |
| `docs/EXCHANGE_FIELD_MAPPING.md`  | Before working with exchange data           |

Full doc index: `docs/README.md`

---

## 4. Key Commands

```bash
# Development
npm run dev              # Start dev server (Turbopack)
npm run build            # Production build
npm run type-check       # TypeScript check (run before pushing)
npm run lint             # ESLint
npm run test             # Jest tests
npm run test:e2e         # Playwright E2E tests

# Diagnostics
npm run diagnose         # Check data freshness across exchanges
npm run check:platforms  # Platform status overview

# Pipeline
node scripts/pipeline-health-check.mjs        # Full health check
node scripts/pipeline-health-check.mjs --quick # Quick freshness check
```

---

## 5. Project Structure (quick map)

```
app/                    # Pages and API routes
  api/                  #   100+ API endpoints
    cron/               #   Scheduled jobs (62 Vercel crons)
  components/           #   All React components
  rankings/             #   Leaderboard pages
  trader/[id]/          #   Trader profile pages

lib/                    # Core logic (import as @/lib/...)
  connectors/           #   Exchange API connectors
  data/                 #   Server-side data functions
  hooks/                #   React hooks (client-side)
  utils/                #   Shared utilities
  supabase/             #   DB client helpers

docs/                   # You are here
scripts/                # CLI tools, import scripts, maintenance
supabase/migrations/    # Database migrations (SQL)
```

For the full directory breakdown, see `CLAUDE.md` > Directory Structure.

---

## 6. Core Concepts

### Data flow

```
Exchanges (32+) → Cron jobs (fetch) → Supabase (store)
                → Enrichment (details) → Arena Score (compute)
                → Leaderboard (rank) → Frontend (display)
```

### Arena Score

The unified ranking metric. Formula: `ReturnScore (0-60) + PnlScore (0-40)`, weighted by confidence and trust. See `lib/utils/arena-score.ts` and `CLAUDE.md` for details.

### Trader identity

Each trader is identified by `(source, source_trader_id)` — a composite key. The same person on Binance and Bybit is two separate records.

### Exchange connectors

Each connector in `lib/connectors/` implements `fetchLeaderboard()` and `fetchTraderDetails()` with built-in rate limiting and circuit breakers.

---

## 7. Your First Task

Recommended: pick a small, low-risk issue to run through the full workflow.

1. **Find a task** — check `TASKS.md` for anything marked P2/P3, or ask Adeline
2. **Create a branch** — `git checkout -b fix/my-first-fix`
3. **Make the change** — follow patterns in `CLAUDE.md`
4. **Test locally** — `npm run type-check && npm run test`
5. **Push and open PR** — `git push -u origin fix/my-first-fix && gh pr create`
6. **Get review** — Adeline reviews, you address feedback
7. **Merge** — squash merge to main
8. **Verify deployment** — wait for Vercel, check the live site

This exercises every part of the workflow: git, code, test, PR, deploy.

---

## 8. Communication

- **Daily sync**: brief message on what you're working on today
- **PR reviews**: aim to review within a few hours
- **Stuck?**: ask after 30 min of being blocked, don't spend hours
- **Before touching shared areas** (DB schema, auth, payments): discuss first

---

## 9. Common Gotchas

| Gotcha                      | Solution                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dev server OOM              | Already handled — npm scripts set `--max-old-space-size=3584`                                                                                             |
| Binance/OKX API returns 403 | Geo-blocked. Use VPS proxy or Cloudflare Worker (see `docs/SCRAPER.md`)                                                                                   |
| `tsc` errors on push        | Pre-push hook blocks push if type-check fails. Fix the errors first.                                                                                      |
| Database migration naming   | Always use `scripts/new-migration.sh <description>` — it avoids timestamp collisions                                                                      |
| Modals scroll leak          | Never write `document.body.style.overflow = 'hidden'`. Use `<ModalOverlay>` or `useModalA11y`. Pre-push hook blocks this pattern.                         |
| Notifications in API routes | Never use raw `supabase.from('notifications').insert()`. Use `sendNotification()` from `lib/data/notifications.ts`. Pre-push hook blocks the raw pattern. |

---

## 10. Useful Links

| Resource           | URL                                         |
| ------------------ | ------------------------------------------- |
| Live site          | https://www.arenafi.org                     |
| GitHub repo        | https://github.com/Adeline117/ranking-arena |
| Vercel dashboard   | Vercel project settings (ask for invite)    |
| Supabase dashboard | Supabase project (ask for invite)           |
| Sentry             | Sentry project (ask for invite)             |
