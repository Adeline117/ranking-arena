#!/bin/bash
# git-push-safe.sh — serialize concurrent pushes to main across N Claude sessions.
#
# Problem: Arena runs up to 7 interactive `claude` processes simultaneously
# in different terminal tabs plus openclaw scheduled jobs, all pushing to
# main with the same git identity. Before this wrapper, 6-8 ref-lock
# rejections per hour were normal — "cannot lock ref 'refs/heads/main':
# is at X but expected Y".
#
# Solution: wrap git push with a mkdir-based mutex (atomic on all POSIX
# systems, unlike flock which is Linux-only). Lock timeout 60s; auto-cleanup
# on exit via trap.
#
# Usage:
#   scripts/git-push-safe.sh                  # push current branch to origin
#   scripts/git-push-safe.sh origin main      # explicit remote + branch

set -e

LOCK_DIR="/tmp/arena-git-push.lock.d"
LOCK_TIMEOUT_SEC=60
LOCK_POLL_MS=100

REMOTE="${1:-origin}"
BRANCH="${2:-$(git rev-parse --abbrev-ref HEAD)}"

acquire_lock() {
  local deadline=$(( $(date +%s) + LOCK_TIMEOUT_SEC ))
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      # Stale lock check: if the holder is >120s old, steal it.
      if [ -f "$LOCK_DIR/pid" ]; then
        local holder_pid
        holder_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")
        if [ -n "$holder_pid" ] && ! kill -0 "$holder_pid" 2>/dev/null; then
          echo "⚠️  git-push-safe: stealing stale lock from dead PID $holder_pid" >&2
          rm -rf "$LOCK_DIR"
          continue
        fi
      fi
      echo "❌ git-push-safe: another push is in progress (${LOCK_TIMEOUT_SEC}s lock timeout)" >&2
      echo "   Retry in a few seconds." >&2
      return 1
    fi
    # Sleep LOCK_POLL_MS milliseconds
    sleep 0.1
  done
  echo "$$" > "$LOCK_DIR/pid"
  return 0
}

release_lock() {
  # Only release if we own it (PID matches)
  if [ -f "$LOCK_DIR/pid" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then
    rm -rf "$LOCK_DIR"
  fi
}

trap release_lock EXIT INT TERM

if ! acquire_lock; then
  exit 1
fi

# Auto-rebase onto latest remote if we've diverged.
if [ "$BRANCH" = "main" ]; then
  echo "🔄 git-push-safe: fetch + rebase check"
  git fetch "$REMOTE" "$BRANCH" --quiet

  LOCAL_HEAD=$(git rev-parse HEAD)
  REMOTE_HEAD=$(git rev-parse "$REMOTE/$BRANCH" 2>/dev/null || echo "$LOCAL_HEAD")

  if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ] && ! git merge-base --is-ancestor "$REMOTE_HEAD" "$LOCAL_HEAD"; then
    STASHED=""
    if ! git diff --quiet || ! git diff --cached --quiet; then
      if git stash push -u -m "git-push-safe:auto-stash $(date +%s)" >/dev/null 2>&1; then
        STASHED="yes"
      fi
    fi

    echo "🔄 git-push-safe: rebasing local $LOCAL_HEAD onto $REMOTE/$BRANCH ($REMOTE_HEAD)"
    if ! git rebase "$REMOTE/$BRANCH"; then
      echo "❌ git-push-safe: rebase conflict — aborting" >&2
      git rebase --abort 2>/dev/null || true
      [ -n "$STASHED" ] && git stash pop >/dev/null 2>&1 || true
      exit 1
    fi

    [ -n "$STASHED" ] && git stash pop >/dev/null 2>&1 || true
  fi
fi

echo "⬆️  git-push-safe: pushing $BRANCH to $REMOTE"
# Tell the pre-push hook we already hold the lock so it skips its own
# acquire (would deadlock otherwise — same lock dir). Export via env so
# the hook subprocess inherits it.
ARENA_PUSH_LOCK_OWNER="$$" git push "$REMOTE" "$BRANCH"
