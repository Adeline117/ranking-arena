#!/usr/bin/env bash
# check-orphan-pages.sh — Detect page.tsx files with no incoming links.
# Exit 1 if orphans found. Wire into pre-push hook to prevent future orphans.
#
# How it works:
#   For each page.tsx, derive its route (e.g. /referral).
#   Search all .ts/.tsx files OUTSIDE the page's own directory for that route.
#   If no references found → orphan.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Pages that are intentionally unreachable from public navigation
ALLOWED_ORPHANS=(
  "app/(app)/offline/page.tsx"                     # PWA offline fallback
  "app/(app)/auth/callback/page.tsx"               # Supabase OAuth redirect
  "app/(app)/exchange/auth/callback/page.tsx"      # Exchange OAuth redirect
  "app/(app)/admin/page.tsx"                       # Admin — direct URL only
  "app/(app)/admin/monitoring/page.tsx"
  "app/(app)/admin/monitoring/pipeline/page.tsx"
  "app/(app)/admin/pipeline/page.tsx"
  "app/(app)/admin/pro-metrics/page.tsx"
  "app/(app)/admin/reports/page.tsx"
  "app/(quiz)/quiz/page.tsx"                       # Quiz — external campaign entry
  "app/(quiz)/quiz/questions/page.tsx"
  "app/(quiz)/quiz/result/page.tsx"
  "app/(app)/onboarding/page.tsx"                  # Post-signup redirect only
  "app/(app)/s/[token]/page.tsx"                   # Snapshot share URLs (generated)
  "app/(app)/share/rank/[trader_key]/page.tsx"     # Social share cards (generated)
  "app/(app)/wrapped/[handle]/page.tsx"            # X/Twitter share pages (generated)
  "app/(app)/pricing/success/page.tsx"             # Stripe checkout redirect
  "app/(app)/tip/success/page.tsx"                 # Tip payment redirect
  "app/(app)/trader/authorize/page.tsx"            # Legacy redirect to /claim
  "app/design-system/page.tsx"                     # Design-system preview prototype — direct URL only
)

path_to_route() {
  local p="$1"
  [ "$p" = "app/page.tsx" ] && { echo "/"; return; }
  p="${p#app/}"
  p="${p%/page.tsx}"
  p=$(echo "$p" | sed -E 's/\([^)]+\)\/?//g')
  p="/${p}"
  p=$(echo "$p" | sed -E 's|//+|/|g; s|/$||')
  [ -z "$p" ] && p="/"
  echo "$p"
}

route_has_incoming_link() {
  local route="$1"
  local page_file="$2"
  local page_dir
  page_dir=$(dirname "$page_file")

  # For dynamic segments [xxx], search for the static prefix
  local search
  if echo "$route" | grep -q '\['; then
    search=$(echo "$route" | sed -E 's/\/\[[^]]+\].*/\//')
  else
    search="$route"
  fi

  # Root "/" matches too broadly
  [ "$search" = "/" ] && return 0

  # Search .ts/.tsx files for the route string, excluding page's own dir + noise dirs
  local count
  count=$(grep -rl --include='*.ts' --include='*.tsx' \
    -F "$search" \
    app/ lib/ \
    2>/dev/null \
    | grep -v "^${page_dir}/" \
    | grep -v node_modules \
    | grep -v '.next/' \
    | wc -l | tr -d ' ') || true

  [ "${count:-0}" -gt 0 ]
}

is_allowed() {
  local page="$1"
  for allowed in "${ALLOWED_ORPHANS[@]}"; do
    [ "$page" = "$allowed" ] && return 0
  done
  return 1
}

orphans=()
all_pages=$(find app -name 'page.tsx' -not -path '*/node_modules/*' -not -path '*/.next/*' | sort)

for page in $all_pages; do
  is_allowed "$page" && continue
  route=$(path_to_route "$page")
  if ! route_has_incoming_link "$route" "$page"; then
    orphans+=("$page  ->  $route")
  fi
done

if [ ${#orphans[@]} -gt 0 ]; then
  echo ""
  echo "ORPHAN PAGES DETECTED — no incoming links found:"
  echo ""
  for o in "${orphans[@]}"; do
    echo "  $o"
  done
  echo ""
  echo "Fix: add a link (href, router.push, or sitemap entry) from another page."
  echo "If intentionally unreachable, add to ALLOWED_ORPHANS in scripts/check-orphan-pages.sh"
  echo ""
  exit 1
else
  echo "No orphan pages found."
  exit 0
fi
