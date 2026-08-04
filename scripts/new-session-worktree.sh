#!/bin/bash
# Create an ISOLATED git worktree for a Claude interactive session.
#
# Why (2026-06 root cause): Arena runs up to ~7 Claude sessions + openclaw + cron
# on ONE shared working tree. Concurrent edits collide live — another session's
# package-lock change, a core-file edit (database.types.ts / eslint.config /
# tsconfig), or a staged-file leak pollutes YOUR validation and commit. A real
# example: a sibling session's lock change made a worker deploy npm-ci on the SG
# box and crash-loop it; another's stale premium test blocked every push.
#
# Fix (industry standard for parallel AI agents): each session works in its own
# worktree on its own branch — same .git object store, separate working dir —
# so conflicts are deferred to the intentional merge point instead of happening
# live. Deliver the owned branch through a pull request; do not coordinate by
# serializing direct pushes to main.
#
# Usage:
#   scripts/new-session-worktree.sh <name>      # create + print next steps
#   scripts/new-session-worktree.sh --list      # list active session worktrees
#   scripts/new-session-worktree.sh --remove <name>   # tear down (after merge)
#
# Dependencies and credentials are intentionally not shared. Each worktree gets
# its own install and only the minimum local environment required for its task.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"
WT_BASE="${ARENA_WORKTREE_BASE:-$REPO_DIR/../ranking-arena-worktrees}"

validate_name() {
  local name="$1"
  if [[ ! "$name" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]]; then
    echo "✗ session name must match ^[a-z0-9][a-z0-9._-]{0,63}$" >&2
    exit 2
  fi
}

if [ "${1:-}" = "--list" ]; then
  git worktree list | sed 's/^/  /'
  exit 0
fi

if [ "${1:-}" = "--remove" ]; then
  NAME="${2:-}"; [ -z "$NAME" ] && { echo "usage: $0 --remove <name>" >&2; exit 2; }
  validate_name "$NAME"
  git worktree remove "$WT_BASE/$NAME"
  if git show-ref --verify --quiet "refs/heads/session/$NAME"; then
    git branch -d "session/$NAME" || {
      echo "△ worktree removed; unmerged branch session/$NAME was retained" >&2
      exit 0
    }
  fi
  echo "✓ removed clean worktree and merged branch session/$NAME"
  exit 0
fi

NAME="${1:-}"
[ -z "$NAME" ] && { echo "usage: $0 <session-name> | --list | --remove <name>" >&2; exit 2; }
validate_name "$NAME"
WT_DIR="$WT_BASE/$NAME"
BRANCH="session/$NAME"
[ -e "$WT_DIR" ] && { echo "✗ $WT_DIR already exists — pick another name or --remove it" >&2; exit 1; }

mkdir -p "$WT_BASE"
echo "→ fetching origin/main…"
git fetch --quiet origin main
echo "→ creating worktree $WT_DIR on branch $BRANCH (off origin/main)…"
git worktree add -b "$BRANCH" "$WT_DIR" origin/main

cat <<EOF

✓ worktree ready: $WT_DIR  (branch $BRANCH; no shared credentials or dependencies)

Next:
  cd $WT_DIR && nvm use && npm ci
  # Add only the minimum task-specific local env, then work HERE.
  cd $WT_DIR && claude
  # commit normally; when done, rebase, push the owned branch, and open a PR:
  cd $WT_DIR && git fetch origin main && git rebase origin/main
  cd $WT_DIR && git push -u origin $BRANCH
  cd $WT_DIR && gh pr create --base main --head $BRANCH
  # tear down only after the PR is integrated:
  scripts/new-session-worktree.sh --remove $NAME
EOF
