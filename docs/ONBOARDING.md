# Onboarding Guide

Welcome to Arena. This doc takes you from zero to productive.

## Table of Contents

- [1. Environment Setup](#1-environment-setup)
- [2. Accounts & Access](#2-accounts--access)
- [3. Reading Order](#3-reading-order)
- [4. Key Commands](#4-key-commands)
- [5. Project Structure](#5-project-structure)
- [6. Core Concepts](#6-core-concepts)
- [7. Your First Task](#7-your-first-task)
- [8. Collaboration Norms](#8-collaboration-norms)
- [9. Common Gotchas](#9-common-gotchas)
- [10. Useful Links](#10-useful-links)

---

## 1. Environment Setup

### Prerequisites (all required)

- **Node.js 20+**
- **npm 10+** (ships with Node)
- **Git**
- **VS Code** (recommended — project includes `.vscode/` settings)

### Steps

```bash
# 1. Clone the repo
git clone git@github.com:Adeline117/ranking-arena.git
cd ranking-arena

# 2. Install dependencies
npm install

# 3. Set up environment variables (ask Adeline for real values)
cp .env.example .env.local
# Then edit .env.local and fill in the actual keys

# 4. Start dev server
npm run dev
# Open http://localhost:3000
```

### Environment Variables: What You Actually Need

`.env.example` has 190+ variables. **You don't need all of them.** Here's what matters:

#### Required (app won't start without these)

```bash
NEXT_PUBLIC_SUPABASE_URL=...         # Supabase project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=...    # Supabase public key (used by frontend)
SUPABASE_SERVICE_ROLE_KEY=...        # Supabase admin key (used by backend, bypasses RLS)
UPSTASH_REDIS_REST_URL=...           # Redis cache URL
UPSTASH_REDIS_REST_TOKEN=...         # Redis auth token
CRON_SECRET=...                      # Auth token for cron job endpoints
```

#### Required only when working on payments

```bash
STRIPE_SECRET_KEY=sk_test_...                  # Stripe test secret key
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_... # Stripe frontend key
STRIPE_WEBHOOK_SECRET=whsec_...                # Stripe webhook signature
```

#### Optional (app runs fine without these, but some features won't work)

```bash
SENTRY_DSN=...              # Error tracking — without it, errors aren't reported
TELEGRAM_BOT_TOKEN=...      # Pipeline alerts — without it, no Telegram notifications
OPENAI_API_KEY=...          # Translation — without it, translation feature is disabled
VPS_PROXY_KEY=...           # VPS scraper proxy — without it, some exchange data is unavailable
```

#### Ignore for now

Web3 (RPC URLs, contract addresses, block explorer keys), HSM, QStash, Smart Scheduler — not needed for day-to-day development.

> **Ask Adeline for a pre-filled `.env.local`. Never commit `.env.local` to Git.**

### Dev Server Notes

- Uses Turbopack (faster than Webpack) — already configured in `npm run dev`
- Needs ~3.5GB memory — already set via `--max-old-space-size=3584` in npm scripts
- First load is slow; subsequent hot reloads are fast

---

## 2. Accounts & Access

Ask Adeline to grant you access to:

| Service      | Access needed                              | Purpose                                 | Required?                     |
| ------------ | ------------------------------------------ | --------------------------------------- | ----------------------------- |
| **GitHub**   | Collaborator on `Adeline117/ranking-arena` | Push branches, open PRs                 | Yes                           |
| **Vercel**   | Team member                                | View deployments, logs, env vars        | Yes                           |
| **Supabase** | Project member                             | Query database, check logs              | Yes                           |
| **Sentry**   | Project member                             | View production errors and performance  | Recommended                   |
| **Upstash**  | Read access                                | Check Redis cache and rate limit status | Optional                      |
| **Stripe**   | Test mode access                           | Test payment flows                      | Only when working on payments |

---

## 3. Reading Order

### Day 1 — Must Read (~1 hour)

Read in this order, don't skip:

| Order | File                                  | Time   | What you'll learn                                                                                                                                       |
| ----- | ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | [CLAUDE.md](../CLAUDE.md)             | 30 min | **The most important file.** Architecture, directory layout, database schema, coding conventions, mandatory patterns, key commands — everything is here |
| 2     | [CONTRIBUTING.md](../CONTRIBUTING.md) | 5 min  | Code style, commit message format, PR process                                                                                                           |
| 3     | [GIT_WORKFLOW.md](./GIT_WORKFLOW.md)  | 5 min  | Branch strategy, how we collaborate as a team                                                                                                           |
| 4     | [PROGRESS.md](../PROGRESS.md)         | 10 min | What happened recently, current state of things                                                                                                         |
| 5     | [TASKS.md](../TASKS.md)               | 10 min | Task backlog and priorities — what to work on next                                                                                                      |

### First Week — Read When Relevant

| File                                                       | When to read                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| [DECISIONS.md](../DECISIONS.md)                            | When you wonder "why was it built this way?"                       |
| [RUNBOOK.md](./RUNBOOK.md)                                 | Before touching anything in production (has real IPs and commands) |
| [SCRAPER.md](./SCRAPER.md)                                 | Before touching the data pipeline or exchange connectors           |
| [API_BEST_PRACTICES.md](./API_BEST_PRACTICES.md)           | Before writing a new API route                                     |
| [RLS_POLICIES.md](./RLS_POLICIES.md)                       | Before touching database tables or policies                        |
| [SECURITY_BEST_PRACTICES.md](./SECURITY_BEST_PRACTICES.md) | Before touching auth, payments, or user data                       |
| [system-principles.md](./system-principles.md)             | Before building UI with state management                           |
| [EXCHANGE_FIELD_MAPPING.md](./EXCHANGE_FIELD_MAPPING.md)   | Before working with exchange data fields                           |

Full doc index: [docs/README.md](./README.md)

---

## 4. Key Commands

### Daily use

```bash
npm run dev              # Start dev server (Turbopack)
npm run type-check       # TypeScript check — run before pushing
npm run lint             # ESLint
npm run test             # Jest unit tests
```

### Occasional use

```bash
npm run build            # Full production build
npm run test:e2e         # Playwright E2E tests
npm run diagnose         # Check data freshness across exchanges
npm run check:platforms  # Platform status overview
```

### Pipeline diagnostics (when data looks wrong)

```bash
node scripts/pipeline-health-check.mjs          # Full health check
node scripts/pipeline-health-check.mjs --quick   # Quick freshness check
node scripts/pipeline-health-check.mjs --fix     # Generate fix script
```

---

## 5. Project Structure

```
app/                    # Next.js pages and API routes
  api/                  #   100+ API endpoints
    cron/               #   Scheduled jobs (62 Vercel crons)
  components/           #   All React components
  rankings/             #   Leaderboard pages
  trader/[id]/          #   Trader profile pages

lib/                    # Core logic (imported as @/lib/...)
  connectors/           #   Exchange API connectors
  data/                 #   Server-side data functions
  hooks/                #   React hooks (client-side)
  utils/                #   Shared utilities
  supabase/             #   Supabase client helpers

docs/                   # Documentation (you are here)
scripts/                # CLI tools, import scripts, maintenance
supabase/migrations/    # Database migrations (SQL)
```

Full directory breakdown: [CLAUDE.md > Directory Structure](../CLAUDE.md#directory-structure).

---

## 6. Core Concepts

### Data flow

```
32+ exchanges → cron jobs (fetch) → Supabase (store)
              → enrichment (details) → Arena Score (compute)
              → leaderboard (rank) → frontend (display)
```

### Arena Score

The unified ranking metric across all exchanges.

- Formula: `ReturnScore (0-60) + PnlScore (0-40)`, scaled by confidence and trust weight
- Period-specific coefficients for 7D / 30D / 90D
- Composite: `90D * 0.70 + 30D * 0.25 + 7D * 0.05`
- Source code: [`lib/utils/arena-score.ts`](../lib/utils/arena-score.ts)

### Trader identity

Each trader is uniquely identified by `(source, source_trader_id)` — a composite key. The same person on Binance and Bybit is two separate records.

### Exchange connectors

Each connector in [`lib/connectors/`](../lib/connectors/) implements:

- `fetchLeaderboard(period)` — get ranked traders
- `fetchTraderDetails(traderId)` — get trader profile

Rate limiting and circuit breakers are built in. See [SCRAPER.md](./SCRAPER.md) for the full architecture.

---

## 7. Your First Task

Pick a small, low-risk issue to run through the full workflow end to end.

```bash
# 1. Pull latest
git checkout main && git pull

# 2. Create a branch
git checkout -b fix/my-first-fix

# 3. Make your change (follow patterns in CLAUDE.md)

# 4. Verify locally
npm run type-check && npm run test

# 5. Push and open a PR
git push -u origin fix/my-first-fix
gh pr create --title "fix: describe what you changed" --body "## Summary\n- ..."

# 6. Adeline reviews → address feedback → merge

# 7. After merge, wait for Vercel deploy (5-8 min), then check live site
```

Look in [TASKS.md](../TASKS.md) for a P2/P3 task, or ask Adeline which one is good for getting started.

For the full git workflow details, see [GIT_WORKFLOW.md](./GIT_WORKFLOW.md).

---

## 8. Collaboration Norms

| Situation                                       | What to do                                                  |
| ----------------------------------------------- | ----------------------------------------------------------- |
| **Daily**                                       | Brief message about what you're working on                  |
| **PR reviews**                                  | Respond within a few hours                                  |
| **Stuck**                                       | Ask after 30 minutes — don't spend hours stuck silently     |
| **Sensitive areas** (DB schema, auth, payments) | Discuss before making changes                               |
| **Commits**                                     | One fix = one commit. Don't batch multiple changes together |

---

## 9. Common Gotchas

| Problem                        | Solution                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dev server runs out of memory  | Already handled — npm scripts set `--max-old-space-size=3584`                                                                                                    |
| Binance/OKX API returns 403    | Geo-blocked. Use VPS proxy or Cloudflare Worker (see [SCRAPER.md](./SCRAPER.md))                                                                                 |
| Push rejected by pre-push hook | The hook runs lint + type-check. Fix all errors before pushing                                                                                                   |
| Database migration naming      | **Must** use `scripts/new-migration.sh <description>` — prevents timestamp collisions                                                                            |
| Modal scroll leak              | **Never** write `document.body.style.overflow = 'hidden'`. Use `<ModalOverlay>` or `useModalA11y`. The pre-push hook blocks this pattern                         |
| Notifications in API routes    | **Never** use raw `supabase.from('notifications').insert()`. Use `sendNotification()` from `lib/data/notifications.ts`. The pre-push hook blocks the raw pattern |
| First `npm run build` is slow  | Normal. Use `npm run dev` for daily work                                                                                                                         |

For production emergencies, see [RUNBOOK.md](./RUNBOOK.md).

---

## 10. Useful Links

| Resource           | URL                                         |
| ------------------ | ------------------------------------------- |
| Live site          | https://www.arenafi.org                     |
| GitHub repo        | https://github.com/Adeline117/ranking-arena |
| Vercel dashboard   | Ask Adeline for invite                      |
| Supabase dashboard | Ask Adeline for invite                      |
| Sentry             | Ask Adeline for invite                      |
| Full doc index     | [docs/README.md](./README.md)               |
