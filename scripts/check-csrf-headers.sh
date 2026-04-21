#!/bin/bash
# check-csrf-headers.sh — Detect client-side fetch() calls missing getCsrfHeaders()
#
# Scans all client-side .ts/.tsx files for mutating fetch() calls (POST/PUT/DELETE/PATCH)
# and reports any that don't include getCsrfHeaders() or a safe wrapper (authedFetch/apiPost/etc).
#
# Usage:
#   scripts/check-csrf-headers.sh           # Full scan
#   scripts/check-csrf-headers.sh --staged  # Only check staged files (for pre-commit)
#
# Exit code: number of files with issues (0 = clean)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

STAGED_ONLY=false
if [[ "${1:-}" == "--staged" ]]; then
  STAGED_ONLY=true
fi

FOUND=0

# Safe wrappers that handle CSRF internally
SAFE_PATTERN='getCsrfHeaders\|authedFetch\|apiPost\|apiDelete\|apiPut\|apiPatch\|apiRequest'

# Known exceptions (public endpoints, external URLs, etc.)
# Add file basenames here if they legitimately don't need CSRF
EXCEPTIONS="WebVitals.tsx|FeedbackWidget.tsx"

get_files() {
  if $STAGED_ONLY; then
    git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|tsx)$' | grep -v '^app/api/' | grep -v '\.test\.\|\.spec\.\|__tests__' || true
  else
    find app -path 'app/api' -prune -o \( -name '*.ts' -o -name '*.tsx' \) -print 2>/dev/null | \
      grep -v '\.test\.\|\.spec\.\|__tests__' | sort
  fi
}

while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ ! -f "$file" ] && continue

  # Skip known exceptions
  basename=$(basename "$file")
  if echo "$basename" | grep -qE "^($EXCEPTIONS)$"; then
    continue
  fi

  # Quick check: does file have any mutating fetch patterns?
  if ! grep -qE "method:\s*['\"]?(POST|PUT|DELETE|PATCH)" "$file" 2>/dev/null; then
    continue
  fi

  # Does file use any safe CSRF wrapper?
  HAS_SAFE=$(grep -c "$SAFE_PATTERN" "$file" 2>/dev/null || true)

  # Count mutating fetch calls
  MUTATIONS=$(grep -cE "method:\s*['\"]?(POST|PUT|DELETE|PATCH)" "$file" 2>/dev/null || true)

  if [ "$HAS_SAFE" -eq 0 ] && [ "$MUTATIONS" -gt 0 ]; then
    echo -e "${RED}✗${NC} $file — ${MUTATIONS} mutating fetch call(s), no CSRF protection found"
    # Show the offending lines
    grep -nE "method:\s*['\"]?(POST|PUT|DELETE|PATCH)" "$file" | while read -r line; do
      echo "    $line"
    done
    FOUND=$((FOUND + 1))
  fi
done < <(get_files)

echo ""
if [ "$FOUND" -eq 0 ]; then
  echo -e "${GREEN}✓ All client-side mutating fetch() calls have CSRF protection${NC}"
else
  echo -e "${YELLOW}⚠ Found $FOUND file(s) with potentially missing CSRF headers${NC}"
  echo -e "  Fix: add ${YELLOW}import { getCsrfHeaders } from '@/lib/api/client'${NC}"
  echo -e "  Then spread ${YELLOW}...getCsrfHeaders()${NC} into fetch headers"
fi

exit "$FOUND"
