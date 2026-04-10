#!/bin/bash
# merge-autofix-to-main.sh — sync openclaw/auto-fix branch into main
#
# Tier 2 of the concurrent-push conflict fix. openclaw autonomous Claude
# sessions run in a separate worktree (~/arena-openclaw) and commit to
# branch `openclaw/auto-fix` instead of main. This script merges those
# commits into main on a schedule (or manually) after a human review.
#
# Runs under the same flock as scripts/git-push-safe.sh so the merge push
# doesn't race interactive Claude sessions.
#
# Usage:
#   scripts/openclaw/merge-autofix-to-main.sh              # auto-merge if clean
#   scripts/openclaw/merge-autofix-to-main.sh --dry-run    # show what would merge
#
# Exit codes:
#   0 = merged successfully (or nothing to merge)
#   1 = merge conflict / review required
#   2 = lock acquisition failed

set -e

DRY_RUN=""
if [ "$1" = "--dry-run" ]; then
  DRY_RUN="yes"
fi

MAIN_CHECKOUT="${ARENA_DIR:-$HOME/ranking-arena}"
FIX_BRANCH="openclaw/auto-fix"

cd "$MAIN_CHECKOUT"

# Fetch latest
git fetch origin main "$FIX_BRANCH" --quiet 2>&1 || true

# Check if the branch exists locally (worktree would have created it)
if ! git rev-parse --verify "$FIX_BRANCH" >/dev/null 2>&1; then
  echo "ℹ️  merge-autofix: branch $FIX_BRANCH does not exist yet — nothing to merge"
  exit 0
fi

# Count commits on openclaw/auto-fix that are NOT yet on main
AHEAD=$(git rev-list --count "main..$FIX_BRANCH" 2>/dev/null || echo "0")
if [ "$AHEAD" = "0" ]; then
  echo "ℹ️  merge-autofix: $FIX_BRANCH is not ahead of main — nothing to merge"
  exit 0
fi

echo "📦 merge-autofix: $AHEAD commit(s) on $FIX_BRANCH ahead of main:"
git log --oneline "main..$FIX_BRANCH" 2>/dev/null | sed 's/^/   /'

if [ -n "$DRY_RUN" ]; then
  echo "ℹ️  merge-autofix: --dry-run, not merging"
  exit 0
fi

# Safety: bail if main has uncommitted changes (someone's work in progress)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "⚠️  merge-autofix: main checkout has uncommitted changes, aborting" >&2
  git status --short >&2
  exit 1
fi

# Run everything inside the same git-push-safe lock so we don't race
# interactive Claude sessions.
LOCK_DIR="/tmp/arena-git-push.lock.d"
acquire() {
  local deadline=$(( $(date +%s) + 120 ))
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      return 1
    fi
    sleep 0.2
  done
  echo "$$" > "$LOCK_DIR/pid"
  return 0
}
release() {
  if [ -f "$LOCK_DIR/pid" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then
    rm -rf "$LOCK_DIR"
  fi
}
trap release EXIT INT TERM

if ! acquire; then
  echo "❌ merge-autofix: could not acquire push lock (120s)" >&2
  exit 2
fi

# Ensure main is up to date with origin
git checkout main --quiet
git pull origin main --ff-only 2>&1 | tail -3 || { echo "❌ merge-autofix: main pull failed" >&2; exit 1; }

# Fast-forward merge if possible, otherwise require human review
if git merge --ff-only "$FIX_BRANCH" 2>&1; then
  echo "✅ merge-autofix: fast-forward merged $AHEAD commit(s) from $FIX_BRANCH"
else
  echo "⚠️  merge-autofix: non-ff merge required — review openclaw/auto-fix manually" >&2
  git merge --abort 2>/dev/null || true
  exit 1
fi

# Push (lock is still ours, pass env var to skip re-acquire in pre-push hook)
ARENA_PUSH_LOCK_OWNER="$$" git push origin main 2>&1 | tail -5
