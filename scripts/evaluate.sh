#!/bin/bash
# Code Quality Evaluator — scores changes, blocks commit if < 80/100
#
# Usage: ./scripts/evaluate.sh
# Returns: exit 0 (score >= 80) or exit 1 (score < 80)
#
# Scoring:
#   TypeScript compilation:  30 pts
#   ESLint clean:            20 pts
#   Unit tests pass:         20 pts
#   No console.log:          10 pts
#   No hardcoded secrets:    10 pts
#   Cron routes have logger: 10 pts

set -o pipefail

THRESHOLD=80
TOTAL=0
MAX=100

echo ""
echo "═══════════════════════════════════════════"
echo "  Code Quality Evaluation (/evaluate)"
echo "═══════════════════════════════════════════"

# 1. TypeScript (30 pts)
echo ""
echo "▸ TypeScript type-check (30 pts)..."
if npx tsc --noEmit 2>/dev/null; then
  echo "  ✓ 30/30"
  TOTAL=$((TOTAL + 30))
else
  echo "  ✗ 0/30 — type errors found"
fi

# 2. ESLint (20 pts)
echo ""
echo "▸ ESLint (20 pts)..."
CHANGED=$(git diff --name-only --diff-filter=d 2>/dev/null | grep -E '\.(ts|tsx)$' | grep -v '__tests__' | grep -v '.test.' || true)
if [ -z "$CHANGED" ]; then
  echo "  ✓ 20/20 — no changed files"
  TOTAL=$((TOTAL + 20))
elif echo "$CHANGED" | xargs npx eslint --max-warnings 0 2>/dev/null; then
  echo "  ✓ 20/20"
  TOTAL=$((TOTAL + 20))
else
  LINT_ERRORS=$(echo "$CHANGED" | xargs npx eslint 2>/dev/null | grep -c "error" || echo "0")
  if [ "$LINT_ERRORS" -le 3 ]; then
    echo "  △ 10/20 — $LINT_ERRORS lint errors"
    TOTAL=$((TOTAL + 10))
  else
    echo "  ✗ 0/20 — $LINT_ERRORS lint errors"
  fi
fi

# 3. Unit tests (20 pts)
echo ""
echo "▸ Unit tests (20 pts)..."
if npx jest --passWithNoTests --bail --silent 2>/dev/null; then
  echo "  ✓ 20/20"
  TOTAL=$((TOTAL + 20))
else
  echo "  ✗ 0/20 — test failures"
fi

# 4. No console.log in changed production code (10 pts)
echo ""
echo "▸ No console.log (10 pts)..."
PROD_CHANGED=$(git diff --name-only --diff-filter=d 2>/dev/null | grep -E '\.(ts|tsx)$' | grep -v '__tests__' | grep -v '.test.' | grep -v 'scripts/' || true)
if [ -z "$PROD_CHANGED" ]; then
  echo "  ✓ 10/10 — no changed production files"
  TOTAL=$((TOTAL + 10))
else
  CONSOLE_COUNT=$(echo "$PROD_CHANGED" | xargs grep -n 'console\.log' 2>/dev/null | grep -v '// eslint' | wc -l | tr -d ' ')
  if [ "$CONSOLE_COUNT" -eq 0 ]; then
    echo "  ✓ 10/10"
    TOTAL=$((TOTAL + 10))
  else
    echo "  ✗ 0/10 — $CONSOLE_COUNT console.log found"
  fi
fi

# 5. No hardcoded secrets (10 pts)
echo ""
echo "▸ No hardcoded secrets (10 pts)..."
SECRET_PATTERNS='(sk_live|pk_live|SUPABASE_SERVICE_ROLE|eyJhbGciOi|ghp_[a-zA-Z0-9]{36})'
if [ -z "$PROD_CHANGED" ]; then
  echo "  ✓ 10/10"
  TOTAL=$((TOTAL + 10))
else
  SECRET_COUNT=$(echo "$PROD_CHANGED" | xargs grep -nE "$SECRET_PATTERNS" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$SECRET_COUNT" -eq 0 ]; then
    echo "  ✓ 10/10"
    TOTAL=$((TOTAL + 10))
  else
    echo "  ✗ 0/10 — $SECRET_COUNT potential secrets found"
  fi
fi

# 6. Cron routes have PipelineLogger (10 pts)
echo ""
echo "▸ Cron harness coverage (10 pts)..."
CRON_TOTAL=0
CRON_COVERED=0
for f in app/api/cron/*/route.ts; do
  [ -f "$f" ] || continue
  CRON_TOTAL=$((CRON_TOTAL + 1))
  if grep -q 'PipelineLogger' "$f" 2>/dev/null; then
    CRON_COVERED=$((CRON_COVERED + 1))
  fi
done
if [ "$CRON_TOTAL" -eq 0 ]; then
  echo "  ✓ 10/10 — no cron routes"
  TOTAL=$((TOTAL + 10))
elif [ "$CRON_COVERED" -ge "$((CRON_TOTAL * 9 / 10))" ]; then
  echo "  ✓ 10/10 — $CRON_COVERED/$CRON_TOTAL crons covered"
  TOTAL=$((TOTAL + 10))
elif [ "$CRON_COVERED" -ge "$((CRON_TOTAL * 7 / 10))" ]; then
  echo "  △ 5/10 — $CRON_COVERED/$CRON_TOTAL crons covered"
  TOTAL=$((TOTAL + 5))
else
  echo "  ✗ 0/10 — only $CRON_COVERED/$CRON_TOTAL crons covered"
fi

# Final score
echo ""
echo "═══════════════════════════════════════════"
echo "  Score: $TOTAL/$MAX (threshold: $THRESHOLD)"
if [ "$TOTAL" -ge "$THRESHOLD" ]; then
  echo "  ✓ PASS — safe to commit"
  echo "═══════════════════════════════════════════"
  exit 0
else
  echo "  ✗ FAIL — fix issues before commit"
  echo "═══════════════════════════════════════════"
  exit 1
fi
