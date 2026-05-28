#!/bin/bash
# Service Layer Enforcement
# Called by pre-push hook. Checks changed API route files for raw DB operations
# that should use unified service functions instead.
#
# Exit 1 = violation found (blocks push)
# Exit 0 = all clean
#
# This script is version-controlled so enforcement survives clones/resets.

set -euo pipefail

# Accept file list via stdin or $1
if [ -n "${1:-}" ]; then
  CHANGED_FILES="$1"
else
  CHANGED_FILES=$(cat)
fi

API_FILES=$(echo "$CHANGED_FILES" | grep -E '^app/api/' | grep -v '/cron/' || true)

if [ -z "$API_FILES" ]; then
  exit 0
fi

ERRORS=""

# Guard 1: Raw notification inserts → must use sendNotification()
while IFS= read -r f; do
  [ -f "$f" ] || continue
  # Allow raw inserts if file contains "// service-layer-exempt: batch" marker
  if grep -q "service-layer-exempt" "$f" 2>/dev/null; then continue; fi
  if grep -lq "\.from(['\"]notifications['\"]).*\.insert" "$f" 2>/dev/null; then
    ERRORS="${ERRORS}❌ Raw .from('notifications').insert in: $f\n"
  fi
done <<< "$API_FILES"

# Guard 2: Raw counter RPCs → must use updateCount()
while IFS= read -r f; do
  [ -f "$f" ] || continue
  if grep -q "service-layer-exempt" "$f" 2>/dev/null; then continue; fi
  if grep -lq "\.rpc(['\"]increment_\|\.rpc(['\"]decrement_" "$f" 2>/dev/null; then
    ERRORS="${ERRORS}❌ Raw .rpc('increment_/decrement_') in: $f\n"
  fi
done <<< "$API_FILES"

if [ -n "$ERRORS" ]; then
  echo ""
  echo "═══ Service Layer Violations ═══"
  echo -e "$ERRORS"
  echo "Fix:"
  echo "  Notifications → sendNotification() from lib/data/notifications.ts"
  echo "  Counters      → updateCount() from lib/services/counters.ts"
  echo "  Docs          → CLAUDE.md 'Notifications/Counters — MANDATORY'"
  echo ""
  exit 1
fi

# Guard 3: Run related tests for changed source files
SOURCE_FILES=$(echo "$CHANGED_FILES" | grep -E '\.(ts|tsx)$' | grep -v '\.test\.\|\.spec\.\|__tests__' || true)
SOURCE_FILES_EXISTING=""
if [ -n "$SOURCE_FILES" ]; then
  while IFS= read -r f; do
    [ -f "$f" ] && SOURCE_FILES_EXISTING="$SOURCE_FILES_EXISTING $f"
  done <<< "$SOURCE_FILES"
fi

if [ -n "$SOURCE_FILES_EXISTING" ]; then
  # shellcheck disable=SC2086
  if ! npx jest --findRelatedTests $SOURCE_FILES_EXISTING --passWithNoTests --ci --silent --forceExit 2>&1; then
    echo ""
    echo "═══ Related Tests Failed ═══"
    echo "Fix the failing tests before pushing."
    exit 1
  fi
fi

exit 0
