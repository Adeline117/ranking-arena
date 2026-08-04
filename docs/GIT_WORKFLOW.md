# Git Workflow

## Branch Strategy

### Main branch

- `main` — production branch, deploys to arenafi.org via Vercel
- Changes are delivered by pull request. Required-check and review enforcement
  must be verified in repository settings; do not infer protection from this file.

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

5. After required checks and review, squash merge to main.

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

## Local and CI Checks

The repository-managed hooks provide:

1. duplicate and newly-added migration-name checks in `pre-commit`;
2. `lint-staged` on exactly the staged files in `pre-commit`; and
3. conventional/debug-marker policy in `commit-msg`.

There is no tracked pre-push hook. Run type-check, full lint, tests, and build in
proportion to the change; CI is the merge gate for the full repository checks.

## PR Checklist

Before opening a PR:

- [ ] `npm run lint` passes
- [ ] `npm run qa:source-policy` passes
- [ ] `npm run type-check` passes
- [ ] `npm test` passes
- [ ] `npm run build` succeeds
- [ ] Rebased on latest main

## Post-Merge

After merging to main, require Deploy Gate's exact-SHA smoke and rollback
evidence. Use `scripts/post-deploy-check.sh <base-url> <expected-full-sha>` only
for an authorized manual verification, then follow `docs/RUNBOOK.md` on failure.

## Concurrent Work

When two people work on the same area:

- Communicate in advance which files you're touching
- Keep PRs small and merge fast to reduce conflicts
- Rebase frequently: `git fetch origin && git rebase origin/main`
