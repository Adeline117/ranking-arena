#!/bin/bash

# Auto-commit with type-check + rollback
# Uses tsc --noEmit instead of full build (Turbopack has symlink issues locally)

if [ -z "$(git diff --name-only)" ] && [ -z "$(git diff --staged --name-only)" ]; then
  exit 0
fi

CHANGED=$(git diff --name-only | head -5 | tr '\n' ', ')

# type-check (faster and more reliable than full build)
if ! npx tsc --noEmit 2>&1 | grep -v "scripts/" > /dev/null 2>&1; then
  # Only fail if errors are in lib/ or app/ (ignore scripts/ pre-existing errors)
  REAL_ERRORS=$(npx tsc --noEmit 2>&1 | grep -E "^(lib|app)/" | head -5)
  if [ -n "$REAL_ERRORS" ]; then
    echo "type-check failed in app/lib code, rolling back: $CHANGED" >&2
    echo "$REAL_ERRORS" >&2
    git checkout -- .
    git clean -fd 2>/dev/null
    exit 2
  fi
fi

# passed - commit + update safe point
git add -A
git commit -m "auto: ${CHANGED%,}" --no-verify
git tag -f last-known-good

exit 0
