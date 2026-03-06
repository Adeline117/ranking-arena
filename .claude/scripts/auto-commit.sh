#!/bin/bash

# Auto-commit + push with fast type-check + rollback
# tsc passes -> commit + push + update safe point
# tsc fails -> rollback

if [ -z "$(git diff --name-only)" ] && [ -z "$(git diff --staged --name-only)" ]; then
  exit 0
fi

CHANGED=$(git diff --name-only | head -5 | tr '\n' ', ')

if ! npx tsc --noEmit 2>/dev/null; then
  echo "type-check failed, rolling back: $CHANGED" >&2
  git checkout -- .
  git clean -fd 2>/dev/null
  exit 2
fi

git add -A
git commit -m "auto: ${CHANGED%,}" --no-verify
git push --no-verify 2>/dev/null || true
git tag -f last-known-good

exit 0
