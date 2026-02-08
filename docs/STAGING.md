# Staging & Preview Deployments

## Overview

Ranking Arena uses Vercel's built-in preview deployments for staging. Production lives at [arenafi.org](https://www.arenafi.org).

## Branch Strategy

| Branch | Environment | URL |
|--------|------------|-----|
| `main` | Production | https://www.arenafi.org |
| `staging` | Staging/Preview | https://ranking-arena-git-staging-tyche1107s-projects.vercel.app |
| Feature branches | Preview | Auto-generated per PR |

## How It Works

Vercel automatically deploys every branch push:

- **Push to `main`** → Production deployment at arenafi.org
- **Push to `staging`** → Preview deployment at a stable staging URL
- **Open a PR** → Preview deployment with a unique URL (posted as a PR comment)

### Preview URL Patterns

- Branch deploys: `ranking-arena-git-<branch>-tyche1107s-projects.vercel.app`
- PR deploys: `ranking-arena-<hash>-tyche1107s-projects.vercel.app`

## Workflow

### Testing a Feature

1. Create feature branch from `main`:
   ```bash
   git checkout -b feature/my-change main
   ```
2. Develop and push — Vercel creates a preview automatically
3. Open PR targeting `staging` for team review
4. Once approved, merge to `staging` → team tests on staging URL
5. When ready for production, merge `staging` → `main` (or PR feature branch → `main`)

### Quick Staging Deploy

```bash
git checkout staging
git merge main        # sync with latest production
git push origin staging
```

## Environment Variables

Vercel supports separate environment variables per environment:

| Scope | Applies To |
|-------|-----------|
| **Production** | `main` branch deployments only |
| **Preview** | All non-production deployments (staging, PRs, feature branches) |
| **Development** | `vercel dev` locally |

### Setting Environment Variables

**Via Vercel Dashboard:**
1. Go to [Vercel Project Settings → Environment Variables](https://vercel.com/tyche1107s-projects/ranking-arena/settings/environment-variables)
2. Add variable and select which environments it applies to
3. For staging-specific values (e.g., different Supabase project), set them under **Preview** scope

**Via CLI:**
```bash
# Add a preview-only variable
npx vercel env add NEXT_PUBLIC_SUPABASE_URL preview

# Add a production-only variable
npx vercel env add NEXT_PUBLIC_SUPABASE_URL production
```

### Recommended Staging Overrides

For a true staging environment, consider separate values for Preview:

| Variable | Production | Preview (Staging) |
|----------|-----------|-------------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Production Supabase | Staging Supabase (optional) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Production key | Staging key (optional) |
| `SUPABASE_SERVICE_ROLE_KEY` | Production key | Staging key (optional) |
| `SENTRY_DSN` | Production DSN | Staging DSN or same |
| `STRIPE_SECRET_KEY` | Live key | Test key |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Live key | Test key |

> **Note:** Preview environment variables apply to ALL preview deployments (staging branch, PRs, feature branches). Vercel does not natively support per-branch env vars. If you need branch-specific config, use `VERCEL_GIT_COMMIT_REF` in your code to conditionally load values.

### Branch-Specific Config Pattern

```typescript
// lib/config.ts
const isStaging = process.env.VERCEL_GIT_COMMIT_REF === 'staging';
const isProduction = process.env.VERCEL_ENV === 'production';
```

## Cron Jobs

⚠️ **Important:** Vercel cron jobs (defined in `vercel.json`) only run on **Production** deployments. They will NOT run on staging/preview. This is actually desirable — you don't want staging crons competing with production data fetching.

To test cron endpoints on staging, call them manually:
```bash
curl https://ranking-arena-git-staging-tyche1107s-projects.vercel.app/api/cron/fetch-traders/binance_futures
```

## Troubleshooting

- **Preview not deploying?** Check Vercel dashboard → Deployments for build errors
- **Wrong env vars?** Verify in Settings → Environment Variables that Preview scope is set
- **Staging out of date?** Merge latest `main` into `staging`
