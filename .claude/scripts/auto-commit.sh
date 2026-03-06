#!/bin/bash

# Auto-commit with build check + rollback
# Used by PostToolUse hook on Write|Edit
# Build passes -> commit + update safe point
# Build fails -> rollback all changes

if [ -z "$(git diff --name-only)" ] && [ -z "$(git diff --staged --name-only)" ]; then
  exit 0
fi

CHANGED=$(git diff --name-only | head -5 | tr '\n' ', ')

# build check
if ! npm run build --silent 2>&1; then
  echo "build failed, rolling back: $CHANGED" >&2
  git checkout -- .
  git clean -fd 2>/dev/null
  exit 2
fi

# passed - commit + update safe point
git add -A
git commit -m "auto: ${CHANGED%,}" --no-verify
git tag -f last-known-good

exit 0
