#!/usr/bin/env bash

# PostgreSQL 17 proof for refund-first non-entitlement ownership. The wrapper
# reuses the full 181830 authority fixture, applies 181835, optionally includes
# the in-flight 181836 lifetime correction when supplied, and then applies the
# standalone 181845 migration under test.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LIFETIME_CORRECTION="${STRIPE_LIFETIME_CORRECTION_MIGRATION:-$ROOT_DIR/supabase/migrations/20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql}"

EXTRA_MIGRATIONS="$ROOT_DIR/supabase/migrations/20260718183500_harden_stripe_entitlement_null_validation.sql"
if [[ -r "$LIFETIME_CORRECTION" ]]; then
  EXTRA_MIGRATIONS="$EXTRA_MIGRATIONS:$LIFETIME_CORRECTION"
fi
EXTRA_MIGRATIONS="$EXTRA_MIGRATIONS:$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.drift.psql"
EXTRA_MIGRATIONS="$EXTRA_MIGRATIONS:$ROOT_DIR/supabase/migrations/20260718184500_classify_non_entitlement_stripe_payments.sql"

export STRIPE_ENTITLEMENT_EXTRA_SETUP_SQL="$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.setup.psql"
export STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS="$EXTRA_MIGRATIONS"
export STRIPE_ENTITLEMENT_EXTRA_PROOF_SQL="$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.fixture.psql"

"$ROOT_DIR/supabase/migrations/__tests__/atomic-stripe-entitlement-identity.pg17.sh"

echo "Non-entitlement Stripe payment ownership PREDEPLOY PostgreSQL 17 proof passed"
