# Deployment Strategy

## Current Flow

```
Push to main → Vercel auto-deploy → Production
```

All pushes to `main` trigger an automatic production deployment via Vercel's GitHub integration.

---

## Recommended: Staging Environment

### Branch Strategy

```
feature/* → PR → staging → main (production)
```

1. **`main`** — Production branch. Always deployable.
2. **`staging`** — Pre-production. Vercel deploys preview for every push.
3. **`feature/*`** — Feature branches. PRs target `staging`.

### Setup Steps

1. **Create staging branch:**
   ```bash
   git checkout main
   git checkout -b staging
   git push -u origin staging
   ```

2. **Vercel Preview Deployments:**
   - Vercel automatically creates preview deployments for every PR and non-production branch push
   - The `staging` branch preview URL can be aliased: **Vercel Dashboard → Project Settings → Domains → Add `staging.ranking-arena.vercel.app`**
   - Set staging-specific env vars in **Vercel → Settings → Environment Variables → Preview**

3. **Environment Variables by Branch:**
   | Variable | Production (`main`) | Preview (`staging`) |
   |----------|-------------------|-------------------|
   | `NEXT_PUBLIC_SUPABASE_URL` | Production Supabase | Staging Supabase |
   | `DATABASE_URL` | Production DB | Staging DB |
   | `SENTRY_ENVIRONMENT` | `production` | `staging` |

### Branch Protection Rules (GitHub)

Configure at **GitHub → Settings → Branches → Branch protection rules:**

#### `main` branch:
- ✅ Require pull request before merging
- ✅ Require approvals: 1
- ✅ Require status checks to pass (CI: lint, test, build)
- ✅ Require branches to be up to date before merging
- ✅ Do not allow bypassing the above settings

#### `staging` branch:
- ✅ Require status checks to pass (CI: lint, test)
- ❌ Approvals not required (faster iteration)

### Deployment Workflow

```
1. Developer creates feature/my-feature from staging
2. Opens PR → staging
3. CI runs (lint, test, build, e2e)
4. Vercel creates preview deployment
5. QA on preview URL
6. Merge to staging → staging preview updates
7. When ready: PR staging → main
8. Merge → production auto-deploy
```

---

## Rollback

Vercel supports instant rollbacks:
- **Dashboard:** Deployments → Select previous deployment → "Promote to Production"
- **CLI:** `vercel rollback`

---

## CI/CD Pipeline

See `.github/workflows/ci.yml` for the full CI pipeline configuration. The pipeline runs:
1. Pre-flight checks (migration version uniqueness)
2. Lint + TypeScript type checking + Unit tests with coverage
3. Production build
4. E2E tests (Playwright)
