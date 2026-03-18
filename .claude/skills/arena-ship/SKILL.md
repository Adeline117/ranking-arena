---
name: arena-ship
description: Release manager. Merge base, run tests, bump version, update CHANGELOG, create PR. One command from done to shipped.
---

# Arena Ship

One-command release workflow. Takes you from "code complete" to "PR open and ready to merge".

## Pre-Flight Checks

### Gate: Engineering Review
Before shipping, verify that `/plan-eng-review` has been completed (or explicitly skipped by the user).

### Step 1: Branch Status
```bash
# Verify we're on a feature branch, not main
git branch --show-current
# Must NOT be main/master

# Check for uncommitted changes
git status
# Must be clean — commit everything first

# Check remote tracking
git log --oneline origin/main..HEAD
# Shows what will be in the PR
```

### Step 2: Merge Base Branch
```bash
# Fetch latest main
git fetch origin main

# Rebase on top of main (prefer rebase over merge for clean history)
git rebase origin/main
# If conflicts: resolve them, then git rebase --continue
```

### Step 3: Run Tests
```bash
# Type check
npm run type-check

# Lint
npm run lint

# Unit tests
npm run test

# If any fail: STOP. Fix before shipping.
```

### Step 4: Review Diff
```bash
# Show full diff against main
git diff origin/main...HEAD --stat
git diff origin/main...HEAD
```

Review the diff for:
- [ ] No debug console.log statements
- [ ] No commented-out code
- [ ] No .env values or secrets
- [ ] No TODO/FIXME that should be resolved
- [ ] Import ordering clean
- [ ] No large binary files

### Step 5: Version Bump

Read current version:
```bash
cat package.json | grep '"version"'
```

Bump according to change type:
- **patch** (0.0.x): Bug fixes, minor improvements
- **minor** (0.x.0): New features, non-breaking
- **major** (x.0.0): Breaking changes (rare)

```bash
npm version patch --no-git-tag-version
# or: npm version minor --no-git-tag-version
```

### Step 6: Update CHANGELOG

Read existing CHANGELOG.md (create if doesn't exist).

Add entry at the top:

```markdown
## [x.y.z] - YYYY-MM-DD

### Added
- [New feature descriptions]

### Changed
- [Modification descriptions]

### Fixed
- [Bug fix descriptions]

### Removed
- [Removed feature descriptions]
```

Generate entries from commit messages:
```bash
git log --oneline origin/main..HEAD
```

### Step 7: Commit Release

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump version to x.y.z

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Step 8: Push & Create PR

```bash
# Push branch
git push -u origin $(git branch --show-current)

# Create PR
gh pr create \
  --title "feat: [concise description]" \
  --body "$(cat <<'EOF'
## Summary
- [1-3 bullet points of what changed]

## Changes
[Detailed list from CHANGELOG]

## Test Plan
- [ ] Type check passes
- [ ] Lint passes
- [ ] Unit tests pass
- [ ] Manual verification of [specific feature]

## Checklist
- [ ] Engineering review completed
- [ ] No breaking changes (or migration documented)
- [ ] CHANGELOG updated
- [ ] Version bumped

Generated with Arena Ship
EOF
)"
```

### Step 9: Post-Ship

- Output the PR URL
- Remind user to check Vercel preview deployment
- If database migrations are included, flag for manual application

## Abort Conditions

STOP and alert the user if:
- On main branch (never ship directly to main)
- Tests fail
- Merge conflicts that can't be auto-resolved
- More than 50 files changed (probably needs splitting)
- Any `.env` or secret files in the diff
