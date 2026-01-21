# Branch Protection Rules

This document describes the recommended branch protection rules for the Ranking Arena repository.

## Overview

Branch protection rules help ensure code quality and prevent accidental or unauthorized changes to important branches.

## Protected Branches

### `main` Branch

The main branch is the production-ready branch. All code merged here should be stable and tested.

#### Recommended Settings

Go to: **Settings** → **Branches** → **Add branch protection rule**

**Branch name pattern:** `main`

##### Protect matching branches

- [x] **Require a pull request before merging**
  - [x] Require approvals: `1`
  - [ ] Dismiss stale pull request approvals when new commits are pushed
  - [ ] Require review from Code Owners
  - [ ] Require approval of the most recent reviewable push

- [x] **Require status checks to pass before merging**
  - [x] Require branches to be up to date before merging
  - Required status checks:
    - `Pre-flight Checks`
    - `Lint & Unit Tests`
    - `Build`

- [x] **Require conversation resolution before merging**

- [x] **Require linear history**
  - Enforces a linear commit history (no merge commits)

- [x] **Include administrators**
  - Apply rules to repository administrators

##### Rules applied to everyone

- [x] **Restrict who can push to matching branches**
  - Only allow merges via pull requests

- [x] **Do not allow bypassing the above settings**

---

## Status Checks Reference

These status checks are defined in `.github/workflows/ci.yml`:

| Check Name | Description | Required |
|------------|-------------|----------|
| `Pre-flight Checks` | Migration version uniqueness | Yes |
| `Lint & Unit Tests` | ESLint + TypeScript + Jest | Yes |
| `Build` | Next.js production build | Yes |
| `E2E Tests` | Playwright browser tests | Recommended |

---

## Branch Naming Conventions

Use descriptive branch names with prefixes:

| Prefix | Purpose | Example |
|--------|---------|---------|
| `feature/` | New features | `feature/user-dashboard` |
| `fix/` | Bug fixes | `fix/login-redirect` |
| `refactor/` | Code refactoring | `refactor/api-structure` |
| `docs/` | Documentation only | `docs/api-guide` |
| `test/` | Test improvements | `test/e2e-coverage` |
| `chore/` | Maintenance tasks | `chore/update-deps` |
| `claude/` | AI-assisted changes | `claude/feature-xyz-abc123` |

---

## Pull Request Workflow

### 1. Create Feature Branch

```bash
git checkout main
git pull origin main
git checkout -b feature/my-feature
```

### 2. Develop and Commit

```bash
# Make changes
git add .
git commit -m "feat: add new feature"
```

Follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation
- `refactor:` - Code refactoring
- `test:` - Adding/updating tests
- `chore:` - Maintenance

### 3. Push and Create PR

```bash
git push -u origin feature/my-feature
# Create PR via GitHub UI
```

### 4. Address Review Feedback

```bash
# Make requested changes
git add .
git commit -m "fix: address review feedback"
git push
```

### 5. Merge

Once all checks pass and approvals are received, squash and merge via GitHub UI.

---

## Emergency Procedures

### Hotfix Process

For critical production issues:

1. Create branch from `main`: `hotfix/critical-fix`
2. Make minimal fix
3. Create PR with `HOTFIX` label
4. Request expedited review
5. Merge after single approval

### Reverting Changes

If a merged PR causes issues:

```bash
# Create revert PR
git checkout main
git pull
git revert -m 1 <merge-commit-sha>
git push -u origin revert/problematic-change
# Create PR
```

---

## Setup Instructions (GitHub CLI)

You can also configure branch protection via GitHub CLI:

```bash
# Install gh CLI
# https://cli.github.com/

# Authenticate
gh auth login

# Create branch protection rule
gh api -X PUT repos/OWNER/REPO/branches/main/protection \
  -F required_status_checks='{"strict":true,"contexts":["Pre-flight Checks","Lint & Unit Tests","Build"]}' \
  -F enforce_admins=true \
  -F required_pull_request_reviews='{"required_approving_review_count":1}' \
  -F restrictions=null \
  -F required_linear_history=true \
  -F allow_force_pushes=false \
  -F allow_deletions=false
```

---

## Related Documentation

- [GIT_WORKFLOW.md](./GIT_WORKFLOW.md) - Git workflow guidelines
- [PR Template](../.github/PULL_REQUEST_TEMPLATE.md) - Pull request template
- [CI Workflow](../.github/workflows/ci.yml) - CI pipeline configuration
