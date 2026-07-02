#!/usr/bin/env bash
# One-shot local-dev env setup for collaborators.
#
# Writes a minimal .env.local with the PUBLIC client values only — the
# NEXT_PUBLIC_* Supabase URL + publishable (anon) key ship inside the site's
# JS bundle to every visitor, so committing them here leaks nothing (security
# is enforced by RLS, which is exactly Supabase's design). Server-side
# secrets (SERVICE_ROLE_KEY, CRON_SECRET, Stripe, Redis) are intentionally
# NOT included: local frontend testing does not need them, and server
# features that want them degrade gracefully.
#
# Usage:  bash scripts/setup-local-env.sh && npm run dev
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  echo ".env.local already exists — not overwriting. Delete it first if you want a fresh one."
  exit 0
fi

cat > .env.local <<'EOF'
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=https://iknktzifjdyujdccyhsv.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_pHZNRPb4DY87ieKtVhekfg_aVj51ZML
EOF

echo "✓ .env.local written (public client values only)."
echo "  Next: npm install && npm run dev  →  http://localhost:3000"
echo "  Note: the FIRST visit to each page compiles on demand (slow once, fast after)."
