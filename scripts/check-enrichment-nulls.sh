#!/bin/bash
# CI check: detect hardcoded null metrics in enrichment fetchers.
#
# Root cause prevention for: GMX 0.9% Sharpe (sharpeRatio: null hardcoded),
# MEXC 0.1% Sharpe (same), Gains 3% coverage (return [] with no fallback).
#
# These patterns silently ship broken data for thousands of traders.
# Every metric should either be computed or have a "// Cannot compute: <reason>" comment.

set -euo pipefail

ERRORS=0
WARNINGS=0

# Check 1: Hardcoded null for key metrics in enrichment stats functions
echo "Checking enrichment fetchers for hardcoded null metrics..."
for f in lib/cron/fetchers/enrichment-*.ts; do
  [ -f "$f" ] || continue
  [[ "$f" == *"-types"* ]] && continue
  [[ "$f" == *".test."* ]] && continue

  # sharpeRatio: null, maxDrawdown: null, profitableTradesPct: null
  NULLS=$(grep -nE '^\s+(sharpeRatio|maxDrawdown|profitableTradesPct):\s*null\s*,' "$f" 2>/dev/null | grep -v '//.*[Cc]annot' || true)
  if [ -n "$NULLS" ]; then
    echo "  ⚠️  $f:"
    echo "$NULLS" | sed 's/^/    /'
    WARNINGS=$((WARNINGS + 1))
  fi
done

# Check 2: Equity curve functions that return [] unconditionally (no fallback)
echo "Checking for unconditional empty returns in equity curve functions..."
for f in lib/cron/fetchers/enrichment-*.ts; do
  [ -f "$f" ] || continue
  [[ "$f" == *"-types"* ]] && continue

  # Functions named fetchXxxEquityCurve that just return []
  EMPTY=$(grep -A2 'export async function fetch.*EquityCurve' "$f" 2>/dev/null | grep -c 'return \[\]' || true)
  if [ "$EMPTY" -gt 0 ]; then
    FUNC=$(grep -n 'export async function fetch.*EquityCurve' "$f" 2>/dev/null | head -1 || true)
    # Only flag if the function body is tiny (< 5 lines = just returns [])
    if [ -n "$FUNC" ]; then
      LINE=$(echo "$FUNC" | cut -d: -f1)
      BODY_LINES=$(sed -n "${LINE},$((LINE+10))p" "$f" | grep -c '.' || true)
      if [ "$BODY_LINES" -le 5 ]; then
        echo "  ⚠️  $f: $(echo "$FUNC" | cut -d: -f2-) — returns [] with no fallback"
        WARNINGS=$((WARNINGS + 1))
      fi
    fi
  fi
done

echo ""
if [ "$ERRORS" -gt 0 ]; then
  echo "❌ $ERRORS error(s), $WARNINGS warning(s)"
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  echo "⚠️  $WARNINGS warning(s) — consider computing metrics instead of hardcoding null"
  exit 0
else
  echo "✅ No hardcoded null metrics found in enrichment fetchers"
  exit 0
fi
