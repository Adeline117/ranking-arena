# Rollback Guide (2026-02-22)

## Baseline before this round
- `a5afd016` (unify diagnostics entry and fix table checks)

## Incremental rollback points

> New commit hashes will be appended after each small-step commit.

1. `a5afd016` — baseline

## Quick rollback commands

Rollback to baseline:
```bash
git reset --hard a5afd016
```

If already pushed and need remote sync:
```bash
git push --force-with-lease
```

Or create a safe revert commit instead of reset:
```bash
git revert <target_commit>
```
