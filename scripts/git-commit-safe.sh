#!/bin/bash
# git-commit-safe.sh — clean-stage commit that ignores prior index state.
#
# Problem (observed during the 2026-04-09 perf session): when a commit
# fails due to a pre-commit hook OR is undone via `git reset --soft HEAD^`,
# the staged files from the previous attempt REMAIN in the index. The next
# `git add foo && git commit` then bundles those leftover files into a
# new commit, polluting commit history with unrelated background-process
# changes (e.g. cron state files modified by openclaw mid-session).
#
# This script always:
#   1. Optionally saves any pre-existing staged state
#   2. Fully unstages everything (`git reset HEAD`)
#   3. Stages ONLY the explicitly-listed files
#   4. Commits with the saved message
#   5. Restores the pre-existing staged state after
#
# Usage:
#   scripts/git-commit-safe.sh "commit message" path/to/file1 path/to/file2
#   scripts/git-commit-safe.sh -F message.txt path/to/file
#
# Notes:
#   - Files passed to this script are stage-and-commit ONLY (any other
#     working-dir or staged changes are excluded from THIS commit, but
#     restored to the index afterwards)
#   - The pre-push hook still runs lint + type-check on the diff
#   - For multi-line commit messages, use heredoc:
#       scripts/git-commit-safe.sh "$(cat <<'EOF'
#       Subject line
#
#       Body paragraph
#       EOF
#       )" path/to/file

set -e

if [ $# -lt 2 ]; then
  echo "Usage: $0 <commit_message> <file1> [file2] ..." >&2
  echo "       $0 -F <msg_file> <file1> [file2] ..." >&2
  exit 1
fi

# Parse args: optional -F <msg_file>, then message, then files
if [ "$1" = "-F" ]; then
  MESSAGE_FROM_FILE="$2"
  shift 2
  if [ ! -f "$MESSAGE_FROM_FILE" ]; then
    echo "❌ git-commit-safe: message file not found: $MESSAGE_FROM_FILE" >&2
    exit 1
  fi
  COMMIT_MSG=$(cat "$MESSAGE_FROM_FILE")
else
  COMMIT_MSG="$1"
  shift
fi

if [ $# -lt 1 ]; then
  echo "❌ git-commit-safe: at least one file path required" >&2
  exit 1
fi

FILES=("$@")

# Save any pre-existing staged state — restored after the commit
PREEX_STAGED=$(git diff --cached --name-only)
PREEX_STAGED_PATCH=""
if [ -n "$PREEX_STAGED" ]; then
  PREEX_STAGED_PATCH=$(mktemp)
  git diff --cached > "$PREEX_STAGED_PATCH"
fi

# Step 1: full unstage
git reset HEAD --quiet

# Step 2: stage only the explicitly-listed files
for f in "${FILES[@]}"; do
  git add "$f" 2>/dev/null || {
    echo "⚠️  git-commit-safe: 'git add $f' returned non-zero (file may have been deleted upstream)" >&2
  }
done

# Step 3: report what's actually staged
STAGED_COUNT=$(git diff --cached --name-only | wc -l | tr -d ' ')
if [ "$STAGED_COUNT" = "0" ]; then
  echo "❌ git-commit-safe: nothing staged after add. Aborting." >&2
  # Restore pre-existing state
  if [ -n "$PREEX_STAGED_PATCH" ]; then
    git apply --cached "$PREEX_STAGED_PATCH" 2>/dev/null || true
    rm -f "$PREEX_STAGED_PATCH"
  fi
  exit 1
fi

# Step 4: commit. If hook fails, the commit fails normally.
git commit -m "$COMMIT_MSG"
COMMIT_EXIT=$?

# Step 5: restore any pre-existing staged state (if any)
if [ -n "$PREEX_STAGED_PATCH" ]; then
  git apply --cached "$PREEX_STAGED_PATCH" 2>/dev/null || true
  rm -f "$PREEX_STAGED_PATCH"
fi

exit $COMMIT_EXIT
