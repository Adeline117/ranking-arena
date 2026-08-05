# Staging & Preview Deployments

> **INCIDENT NO-GO — this legacy Preview workflow is suspended.** The generic
> Vercel Preview/Development high-privilege variables were cleared, all four
> protection bypasses were revoked, and Git integration was disconnected. This
> removed the known inheritance path but did not create a qualified staging
> environment: the exact old branch override is not proved disposable, and both
> Git-linked Supabase Preview projects fail historical reconstruction. Do not
> restore deployment integration, add secrets, invoke a Preview cron, or follow
> the legacy mutation commands below until
> [`V1_EXECUTION_STATUS_2026-08-04.md`](./V1_EXECUTION_STATUS_2026-08-04.md)
> records disposable staging isolation and owner GO.

## Overview

Historically Ranking Arena treated Vercel Preview as staging. The known generic
secret leakage path is now cleared, but no Preview has proved an isolated
database, clean baseline, fixtures, source trust, or successful deployment; the
model is still prohibited. Production lives
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
release path. Vercel automatically deployed every branch push before Git
integration was disconnected. A PR push used only for code review is not a
staging deployment and cannot satisfy any staging gate:

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

There is no authorized quick deploy path. A direct push is not a staging action;
if Git integration or Preview secrets are restored, it could recreate the old
exposure. Any deployment-producing push without the approved isolation and
owner GO is a release-control violation.

## Environment Variables

Vercel supports separate environment-variable scopes. The known generic
Preview/Development production credentials have been removed, but the exact
old branch override and a complete disposable staging secret set are not yet
proved. Empty scopes are containment, not a usable staging environment; scope
labels alone are not isolation.

| Scope           | Applies To                                                      |
| --------------- | --------------------------------------------------------------- |
| **Production**  | `main` branch deployments only                                  |
| **Preview**     | All non-production deployments (staging, PRs, feature branches) |
| **Development** | `vercel dev` locally                                            |

### Setting Environment Variables (owner-only after GO)

The following describes provider capabilities, not a current instruction to
change Vercel state. During NO-GO, do not add Preview or Production variables
from the CLI or Dashboard. After owner approval, record only variable names,
scope, owner, and verification result—never values.

**Via Vercel Dashboard:**

1. Go to [Vercel Project Settings → Environment Variables](https://vercel.com/tyche1107s-projects/ranking-arena/settings/environment-variables)
2. Add variable and select which environments it applies to
3. For staging-specific values (e.g., different Supabase project), set them under **Preview** scope

CLI mutation is intentionally omitted from this suspended runbook. Use the
approved secret-management channel and a separately reviewed exact scope plan.

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
