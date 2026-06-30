#!/bin/bash
# Create an ISOLATED git worktree for a Claude interactive session.
#
# Why (2026-06 root cause): Arena runs up to ~7 Claude sessions + openclaw + cron
# on ONE shared working tree. Concurrent edits collide live — another session's
# package-lock change, a core-file edit (database.types.ts / eslint.config /
# tsconfig), or a staged-file leak pollutes YOUR pre-push tsc/lint/commit. A real
# example: a sibling session's lock change made a worker deploy npm-ci on the SG
# box and crash-loop it; another's stale premium test blocked every push.
#
# Fix (industry standard for parallel AI agents): each session works in its own
# worktree on its own branch — same .git object store, separate working dir —
# so conflicts are deferred to the intentional merge point instead of happening
# live. Merge back to main through the SAME push lock everyone else uses.
# Mirrors the proven openclaw/auto-fix pattern (~/arena-openclaw on its own branch).
#
# Usage:
#   scripts/new-session-worktree.sh <name>      # create + print next steps
#   scripts/new-session-worktree.sh --list      # list active session worktrees
#   scripts/new-session-worktree.sh --remove <name>   # tear down (after merge)
#
# Heavy/uncommitted local state (.env*, node_modules) is SYMLINKED from the main
# checkout, not copied — instant, no extra disk, deps stay in sync with the lock.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"
WT_BASE="${ARENA_WORKTREE_BASE:-$HOME/arena-worktrees}"

if [ "${1:-}" = "--list" ]; then
  git worktree list | sed 's/^/  /'
  exit 0
fi

if [ "${1:-}" = "--remove" ]; then
  NAME="${2:-}"; [ -z "$NAME" ] && { echo "usage: $0 --remove <name>" >&2; exit 2; }
  git worktree remove "$WT_BASE/$NAME" --force 2>/dev/null || true
  git branch -D "session/$NAME" 2>/dev/null || true
  echo "✓ removed worktree + branch session/$NAME"
  exit 0
fi

NAME="${1:-}"
[ -z "$NAME" ] && { echo "usage: $0 <session-name> | --list | --remove <name>" >&2; exit 2; }
WT_DIR="$WT_BASE/$NAME"
BRANCH="session/$NAME"
[ -e "$WT_DIR" ] && { echo "✗ $WT_DIR already exists — pick another name or --remove it" >&2; exit 1; }

mkdir -p "$WT_BASE"
echo "→ fetching origin/main…"
git fetch --quiet origin main
echo "→ creating worktree $WT_DIR on branch $BRANCH (off origin/main)…"
git worktree add -b "$BRANCH" "$WT_DIR" origin/main

# Share local-only state via symlink (never committed, never copied).
for f in .env .env.local worker/.env; do
  if [ -e "$REPO_DIR/$f" ]; then
    mkdir -p "$(dirname "$WT_DIR/$f")"
    ln -sfn "$REPO_DIR/$f" "$WT_DIR/$f"
  fi
done
# node_modules: symlink so tsc/lint/jest work immediately, deps match the lock.
[ -d "$REPO_DIR/node_modules" ] && ln -sfn "$REPO_DIR/node_modules" "$WT_DIR/node_modules"

cat <<EOF

✓ worktree ready: $WT_DIR  (branch $BRANCH, env + node_modules symlinked)

Next:
  cd $WT_DIR && claude          # do all session work HERE — isolated from main + other sessions
  # commit normally; when done, merge to main through the shared push lock:
  cd $WT_DIR && git rebase origin/main && scripts/git-push-safe.sh
  # OR ff-merge the branch from the main checkout (like openclaw does):
  #   (cd $REPO_DIR && git fetch && git merge --ff-only $BRANCH && scripts/git-push-safe.sh)
  # tear down when merged:
  scripts/new-session-worktree.sh --remove $NAME
EOF
