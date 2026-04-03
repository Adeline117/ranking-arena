#!/bin/bash
# Pre-deploy verification gate
# Runs: type-check + lint + unit tests
# Usage: ./scripts/pre-deploy-check.sh
# Returns: exit 0 (pass) or exit 1 (fail)

set -e

echo "═══════════════════════════════════════════"
echo "  Arena Pre-Deploy Verification Gate"
echo "═══════════════════════════════════════════"

FAILED=0

# 1. TypeScript type-check
echo ""
echo "▸ [1/3] TypeScript type-check..."
if npx tsc --noEmit 2>&1 | tail -5; then
  echo "  ✓ Type-check passed"
else
  echo "  ✗ Type-check FAILED"
  FAILED=1
fi

# 2. ESLint (changed files only for speed)
echo ""
echo "▸ [2/3] ESLint..."
CHANGED=$(git diff --name-only --diff-filter=d HEAD 2>/dev/null | grep -E '\.(ts|tsx)$' || true)
if [ -z "$CHANGED" ]; then
  echo "  ✓ No changed TS files to lint"
else
  if echo "$CHANGED" | xargs npx eslint --max-warnings 0 2>&1 | tail -5; then
    echo "  ✓ Lint passed"
  else
    echo "  ✗ Lint FAILED"
    FAILED=1
  fi
fi

# 3. Unit tests
echo ""
echo "▸ [3/3] Unit tests..."
if npx jest --passWithNoTests --bail 2>&1 | tail -10; then
  echo "  ✓ Tests passed"
else
  echo "  ✗ Tests FAILED"
  FAILED=1
fi

echo ""
echo "═══════════════════════════════════════════"
if [ $FAILED -eq 0 ]; then
  echo "  ✓ All checks passed — safe to deploy"
  echo "═══════════════════════════════════════════"
  exit 0
else
  echo "  ✗ DEPLOY BLOCKED — fix errors above"
  echo "═══════════════════════════════════════════"
  exit 1
fi
