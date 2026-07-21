#!/usr/bin/env bash

# PostgreSQL 17 proof that applies the real production atomic group-pass
# migration before 181845. This catches semantic drift hidden by a simplified
# test writer while retaining the full Stripe entitlement authority chain.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

export STRIPE_ENTITLEMENT_EXTRA_SETUP_SQLS="$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.production-group.setup.psql:$ROOT_DIR/supabase/migrations/20260716176000_atomic_group_pass.sql"
export STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS="$ROOT_DIR/supabase/migrations/20260718183500_harden_stripe_entitlement_null_validation.sql:$ROOT_DIR/supabase/migrations/20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql:$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.drift.psql:$ROOT_DIR/supabase/migrations/20260718184500_classify_non_entitlement_stripe_payments.sql"
export STRIPE_ENTITLEMENT_EXTRA_PROOF_SQL="$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.production-group.fixture.psql"

"$ROOT_DIR/supabase/migrations/__tests__/atomic-stripe-entitlement-identity.pg17.sh"

echo "Production-shaped non-entitlement Stripe group ownership PG17 proof passed"
