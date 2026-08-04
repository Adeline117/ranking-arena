# Staging & Preview Deployments

> **INCIDENT NO-GO — this legacy Preview workflow is suspended.** As of the
> 2026-08-03/04 audit, the main Vercel project's Preview scope inherits
> production database, Supabase service-role, Stripe, R2, encryption, and other
> high-privilege secrets. The two test projects have no usable isolated
> environment or successful deployment. Do not push a candidate/staging/PR
> branch, invoke a Preview cron, or follow the legacy commands below until
> [`V1_EXECUTION_STATUS_2026-08-03.md`](./V1_EXECUTION_STATUS_2026-08-03.md)
> records disposable staging isolation and owner GO.

## Overview

Historically Ranking Arena treated Vercel Preview as staging. That model is not
an isolated staging environment and is currently prohibited. Production lives
at [arenafi.org](https://www.arenafi.org); a replacement staging environment must
use a disposable database, Stripe test mode, staging-only storage/keys, no
production secrets, and a protected GitHub environment with a required reviewer.

## Branch Strategy

| Branch           | Environment               | URL                        |
| ---------------- | ------------------------- | -------------------------- |
| `main`           | Production                | https://www.arenafi.org    |
| `staging`        | Legacy Preview — disabled | Do not deploy during NO-GO |
| Feature branches | Preview — disabled        | Do not deploy during NO-GO |

## How It Works

The following is the **historical Vercel behavior**, not an authorized current
release path. Vercel automatically deployed every branch push; this is
precisely why all pushes are now blocked until Preview secrets are isolated:

- **Historical:** push to `main` → Production deployment at arenafi.org
- **Historical:** push to `staging` → Preview deployment at a stable staging URL
- **Historical:** open a PR → Preview deployment with a unique URL

### Preview URL Patterns

- Branch deploys: `ranking-arena-git-<branch>-tyche1107s-projects.vercel.app`
- PR deploys: `ranking-arena-<hash>-tyche1107s-projects.vercel.app`

## Legacy workflow (disabled)

The previous create/push/PR flow is suspended. Local work must remain in an
isolated worktree and local branch. After owner GO, use only the protected
workflow bound to the disposable staging project and exact candidate SHA.

### Quick Staging Deploy — removed

There is no authorized quick deploy path. A direct push would create a
high-privilege Preview and is a release-control violation.

## Environment Variables

Vercel supports separate environment-variable scopes, but the current project
has production credentials in Preview. Scope labels alone are not isolation.

| Scope           | Applies To                                                      |
| --------------- | --------------------------------------------------------------- |
| **Production**  | `main` branch deployments only                                  |
| **Preview**     | All non-production deployments (staging, PRs, feature branches) |
| **Development** | `vercel dev` locally                                            |

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

For a true staging environment, all high-privilege values must be separate:

| Variable                             | Production          | Preview (Staging)           |
| ------------------------------------ | ------------------- | --------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`           | Production Supabase | Disposable staging Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`      | Production key      | Staging-only key            |
| `SUPABASE_SERVICE_ROLE_KEY`          | Production key      | Staging-only key            |
| `SENTRY_DSN`                         | Production DSN      | Staging DSN or same         |
| `STRIPE_SECRET_KEY`                  | Live key            | Test key                    |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Live key            | Test key                    |

> **Gate:** Preview variables apply to all preview deployments. Application-side
> branch conditionals are not a secret boundary and cannot authorize staging.

### Branch-Specific Config Pattern

```typescript
// lib/config.ts
const isStaging = process.env.VERCEL_GIT_COMMIT_REF === 'staging'
const isProduction = process.env.VERCEL_ENV === 'production'
```

## Cron Jobs

⚠️ **Important:** Vercel cron jobs (defined in `vercel.json`) only run on **Production** deployments. They will NOT run on staging/preview. This is actually desirable — you don't want staging crons competing with production data fetching.

Do not manually call cron endpoints on the legacy Preview. After isolation,
invoke only an allowlisted test endpoint with staging-only credentials and
verify that it cannot reach production data or queues.

## Troubleshooting

- **Preview not deploying?** Check Vercel dashboard → Deployments for build errors
- **Wrong env vars?** Verify in Settings → Environment Variables that Preview scope is set
- **Staging out of date?** Do not sync or push it while the Preview isolation
  gate is open. Continue in a local isolated worktree; rebuild disposable
  staging only after its credentials and queues are proven production-free.
