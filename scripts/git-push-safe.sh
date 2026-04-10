#!/bin/bash
# git-push-safe.sh — serialize concurrent pushes to main across N Claude sessions.
#
# Problem: Arena runs up to 7 interactive `claude` processes simultaneously
# in different terminal tabs plus openclaw scheduled jobs, all pushing to
# main with the same git identity. Before this wrapper, 6-8 ref-lock
# rejections per hour were normal — "cannot lock ref 'refs/heads/main':
# is at X but expected Y".
#
# Solution: wrap git push with an flock(1) so only one process's
# fetch → rebase → push sequence runs at a time. Lock is held on
# /tmp/arena-git-push.lock with a 60s timeout.
#
# Usage:
#   scripts/git-push-safe.sh                  # push current branch to origin
#   scripts/git-push-safe.sh origin main      # explicit remote + branch
#
# CLAUDE.md mandates using this instead of raw `git push origin main` for
# any agent work. Interactive users can still `git push` manually — the
# pre-push hook applies the same flock so concurrent pushes are serialized
# either way.

set -e

LOCK_FILE="/tmp/arena-git-push.lock"
LOCK_TIMEOUT_SEC=60

REMOTE="${1:-origin}"
BRANCH="${2:-$(git rev-parse --abbrev-ref HEAD)}"

# Open lock FD 200 on the lock file. The lock releases automatically
# when this script exits (FD close).
exec 200>"$LOCK_FILE"

if ! flock -x -w "$LOCK_TIMEOUT_SEC" 200; then
  echo "❌ git-push-safe: another push is in progress (${LOCK_TIMEOUT_SEC}s lock timeout)" >&2
  echo "   Retry in a few seconds." >&2
  exit 1
fi

# Auto-rebase onto latest remote if we've diverged. Only for main —
# leave feature branches alone since their rebase semantics differ.
if [ "$BRANCH" = "main" ]; then
  echo "🔄 git-push-safe: fetch + rebase check"
  git fetch "$REMOTE" "$BRANCH" --quiet

  LOCAL_HEAD=$(git rev-parse HEAD)
  REMOTE_HEAD=$(git rev-parse "$REMOTE/$BRANCH" 2>/dev/null || echo "$LOCAL_HEAD")

  if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ] && ! git merge-base --is-ancestor "$REMOTE_HEAD" "$LOCAL_HEAD"; then
    # Stash any unstaged changes before rebase (auto-updater / cron
    # side-effects), then restore after.
    STASHED=""
    if ! git diff --quiet || ! git diff --cached --quiet; then
      STASHED=$(git stash push -u -m "git-push-safe:auto-stash $(date +%s)" 2>/dev/null && echo "yes" || echo "")
    fi

    echo "🔄 git-push-safe: rebasing local $LOCAL_HEAD onto $REMOTE/$BRANCH ($REMOTE_HEAD)"
    if ! git rebase "$REMOTE/$BRANCH"; then
      echo "❌ git-push-safe: rebase conflict — aborting" >&2
      git rebase --abort 2>/dev/null || true
      [ -n "$STASHED" ] && git stash pop 2>/dev/null || true
      exit 1
    fi

    [ -n "$STASHED" ] && git stash pop 2>/dev/null || true
  fi
fi

# Do the push while still holding the lock. If another process had the
# lock first, they already pushed + released; we rebased onto their work
# in the block above, so our push is now a fast-forward.
echo "⬆️  git-push-safe: pushing $BRANCH to $REMOTE"
git push "$REMOTE" "$BRANCH"
