# Onboarding Guide

Welcome to Arena. This doc takes you from zero to productive.

> **V1 NO-GO:** onboarding covers local development, isolated branches, and Draft
> PR review only. Production dashboards, services, hosts, schedulers, workers, and
> credentials are owner-controlled. Production evidence is allowed only when the
> owner has approved the exact read-only query; no request in this guide authorizes
> a write, deployment, migration, cache action, cron invocation, restart, fetch,
> backfill, proxy, or recovery action. The checked-in V1 source configuration has
> **0 Vercel schedules** and disables Git-triggered Vercel deployment; neither
> source setting proves deployed control-plane state.

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

# 3. Set up local development variables (ask the owner for non-production values)
cp .env.example .env.local
# Then edit .env.local with only the values needed for the local task

# 4. Start dev server
npm run dev
# Open http://localhost:3000
```

### Environment Variables: What You Actually Need

`.env.example` has 190+ variables. **You don't need all of them.** Here's what matters:

#### Local development values

Ask the owner for the smallest set of **non-production** values needed to run the
specific local task. Do not request, handle, or copy production service-role keys,
cron secrets, dashboard tokens, or host keys.

```bash
NEXT_PUBLIC_SUPABASE_URL=...         # Local/dev project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=...    # Local/dev public key
UPSTASH_REDIS_REST_URL=...           # Local/dev cache URL, if needed
UPSTASH_REDIS_REST_TOKEN=...         # Local/dev cache token, if needed
```

#### Required only when working on payments

```bash
STRIPE_SECRET_KEY=sk_test_...                  # Stripe test secret key
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_... # Stripe frontend key
STRIPE_WEBHOOK_SECRET=whsec_...                # Stripe webhook signature
```

#### Optional (app runs fine without these, but some features won't work)

```bash
SENTRY_DSN=...              # Local/dev error tracking, if provisioned
OPENAI_API_KEY=...          # Local/dev translation feature, if provisioned
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

Ask Adeline only for access that is approved and scoped to your local task:

| Service      | Access needed                                | Purpose                                       | Required?                     |
| ------------ | -------------------------------------------- | --------------------------------------------- | ----------------------------- |
| **GitHub**   | Collaborator on `Adeline117/ranking-arena`   | Isolated branches and Draft PRs               | Yes                           |
| **Vercel**   | No standing contributor access               | Owner-controlled; evidence only when approved | No                            |
| **Supabase** | No standing contributor access               | Owner-controlled; evidence only when approved | No                            |
| **Sentry**   | No standing contributor access               | Owner-controlled; evidence only when approved | No                            |
| **Upstash**  | No standing contributor access               | Owner-controlled; evidence only when approved | No                            |
| **Stripe**   | Test-mode access, if the owner provisions it | Local payment-flow development                | Only when working on payments |

---

## 3. Reading Order

### Day 1 — Must Read (~1 hour)

Read in this order, don't skip:

| Order | File                                  | Time   | What you'll learn                                                                                                                                       |
| ----- | ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | [CLAUDE.md](../CLAUDE.md)             | 30 min | **The most important file.** Architecture, directory layout, database schema, coding conventions, mandatory patterns, key commands — everything is here |
| 2     | [CONTRIBUTING.md](../CONTRIBUTING.md) | 5 min  | Code style, commit message format, PR process                                                                                                           |
| 3     | [GIT_WORKFLOW.md](./GIT_WORKFLOW.md)  | 5 min  | Branch strategy, how we collaborate as a team                                                                                                           |
| 4     | [PROGRESS.md](./PROGRESS.md)          | 10 min | What happened recently, current state of things                                                                                                         |
| 5     | [TASKS.md](./TASKS.md)                | 10 min | Task backlog and priorities — what to work on next                                                                                                      |

### First Week — Read When Relevant

| File                                                       | When to read                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [DECISIONS.md](./DECISIONS.md)                             | When you wonder "why was it built this way?"                                   |
| [RUNBOOK.md](./RUNBOOK.md)                                 | V1 NO-GO boundary and owner escalation; do not execute its historical commands |
| [SCRAPER.md](./SCRAPER.md)                                 | Data-pipeline architecture; not an instruction to operate connectors           |
| [API_BEST_PRACTICES.md](./API_BEST_PRACTICES.md)           | Before writing a new API route                                                 |
| [RLS_POLICIES.md](./RLS_POLICIES.md)                       | Before touching database tables or policies                                    |
| [SECURITY_BEST_PRACTICES.md](./SECURITY_BEST_PRACTICES.md) | Before touching auth, payments, or user data                                   |
| [system-principles.md](./system-principles.md)             | Before building UI with state management                                       |
| [EXCHANGE_FIELD_MAPPING.md](./EXCHANGE_FIELD_MAPPING.md)   | Before working with exchange data fields                                       |

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
npm run build            # Full local production-mode build
npm run test:e2e         # Playwright E2E tests
# `diagnose` and `check:platforms` can contact external services or controlled
# credentials. Do not run either during V1 unless the owner has approved the exact
# read-only evidence query.
```

### Pipeline diagnostics (owner-scoped evidence only)

The named `check:*` diagnostics may contact public services or controlled read
credentials. Do not run one merely because this guide names it: the owner must first
approve the exact read-only evidence query. No diagnostic authorizes a schedule,
fetch, mutation, backfill, cleanup, or repair. Do not use the old health,
local-recompute, source-fetch, checkpoint, or legacy-backfill paths as evidence or
remediation; the V1 tombstone contract makes them report `RETIRED` and exit 2.

---

## 5. Project Structure

```
app/                    # Next.js pages and API routes
  api/                  #   100+ API endpoints
    cron/               #   53 route implementations; V1 schedules: 0
  components/           #   All React components
  (app)/rankings/       #   Supplementary rankings routes
  (app)/trader/[handle] #   Trader profile pages

lib/                    # Core logic (imported as @/lib/...)
  ingest/adapters/      #   SourceAdapter implementations
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
adapter/parser code → evidence and staging contracts → serving model
                                                → leaderboard → frontend

V1 does not authorize this flow to run. It has no Vercel schedules and no
contributor-operated worker, host, proxy, fetch, backfill, or recovery path.
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

Each adapter in [`lib/ingest/adapters/`](../lib/ingest/adapters/) models:

- `fetchLeaderboard(period)` — get ranked traders
- `fetchTraderDetails(traderId)` — get trader profile

Rate limiting and circuit breakers are part of the code contract. See
[SCRAPER.md](./SCRAPER.md) for architecture only; do not invoke a connector or
work around source access during V1 NO-GO.

---

## 7. Your First Task

Pick a small, low-risk issue to run through the full workflow end to end.

```bash
# 1. Start an isolated feature branch from the reviewed base
git fetch origin main
git switch --create fix/my-first-fix --track origin/main

# 2. Make your change (follow patterns in CLAUDE.md)

# 3. Verify locally
npm run type-check && npm run test

# 4. Stop here unless the current task explicitly authorizes publishing
#    A branch push and Draft PR are external writes; this document grants neither.

# 5. If publishing is authorized, Adeline reviews → address feedback → merge

# 6. After merge, record the PR/commit outcome. A merge does not prove a deployment.
#    Do not invoke a production check or release action unless a separately recorded
#    owner GO opens the V1 release gate.
```

Look in [TASKS.md](./TASKS.md) for a P2/P3 task, or ask Adeline which one is good for getting started.

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
| Binance/OKX API returns 403    | Do not work around it with a proxy, host, or worker. Record reproducible local evidence and ask the owner for a bounded, read-only evidence plan.                |
| Push rejected by pre-push hook | The hook runs lint + type-check. Fix all errors before pushing                                                                                                   |
| Database migration naming      | **Must** use `scripts/new-migration.sh <description>` for a source candidate; never apply it during V1 NO-GO                                                     |
| Modal scroll leak              | **Never** write `document.body.style.overflow = 'hidden'`. Use `<ModalOverlay>` or `useModalA11y`. The pre-push hook blocks this pattern                         |
| Notifications in API routes    | **Never** use raw `supabase.from('notifications').insert()`. Use `sendNotification()` from `lib/data/notifications.ts`. The pre-push hook blocks the raw pattern |
| First `npm run build` is slow  | Normal. Use `npm run dev` for daily work                                                                                                                         |

For a production concern, record the evidence and notify the owner. During V1
NO-GO, do not execute an emergency, recovery, proxy, worker, or deployment action.

---

## 10. Useful Links

| Resource           | URL                                               |
| ------------------ | ------------------------------------------------- |
| Product reference  | Owner-approved read-only: https://www.arenafi.org |
| GitHub repo        | https://github.com/Adeline117/ranking-arena       |
| Vercel dashboard   | Owner-controlled; no standing contributor access  |
| Supabase dashboard | Owner-controlled; no standing contributor access  |
| Sentry             | Owner-controlled; no standing contributor access  |
| Full doc index     | [docs/README.md](./README.md)                     |
