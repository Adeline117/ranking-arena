# Git Workflow

## Branch Strategy

### Main branch

- `main` — production branch, deploys to arenafi.org via Vercel
- Protected: requires 1 review before merge

### Feature branches

```
feature/<description>    # New feature
fix/<description>        # Bug fix
refactor/<description>   # Code refactor
docs/<description>       # Documentation
chore/<description>      # Build/config
```

## Daily Workflow

1. Pull latest main:

   ```bash
   git checkout main && git pull
   ```

2. Create feature branch:

   ```bash
   git checkout -b feature/my-change
   ```

3. Develop, commit atomically (one fix = one commit):

   ```bash
   git add <files>
   git commit -m "feat(rankings): add ROI filter for 90D period"
   ```

4. Push and open PR:

   ```bash
   git push -u origin feature/my-change
   gh pr create --title "feat: add ROI filter" --body "..."
   ```

5. After review + approval, squash merge to main.

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat:     New feature
fix:      Bug fix
perf:     Performance improvement
refactor: Code change (no feature/fix)
test:     Adding/updating tests
docs:     Documentation only
chore:    Build, CI, tooling
```

Examples:

- `feat(rankings): add ROI filter for 90D period`
- `fix(auth): handle expired Supabase session`
- `perf: lazy load web3 wallet components`

## Pre-Push Checks

The pre-push hook automatically runs:

1. `eslint` on changed files
2. `tsc --noEmit` (type-check)

Both must pass before push is allowed.

## PR Checklist

Before opening a PR:

- [ ] `npm run lint` passes
- [ ] `npm run type-check` passes
- [ ] `npm test` passes
- [ ] `npm run build` succeeds
- [ ] Rebased on latest main

## Post-Merge

After merging to main, verify deployment:

```bash
scripts/post-deploy-check.sh
```

If any core URL returns 500, rollback immediately via Vercel Dashboard.

## Concurrent Work

When two people work on the same area:

- Communicate in advance which files you're touching
- Keep PRs small and merge fast to reduce conflicts
- Rebase frequently: `git fetch origin && git rebase origin/main`
