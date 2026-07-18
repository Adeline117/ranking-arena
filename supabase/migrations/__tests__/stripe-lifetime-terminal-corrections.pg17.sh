#!/usr/bin/env bash

# PostgreSQL 17 integration proof for lifetime duplicate-refund durability and
# exact early signed-Checkout-expiration release. It reuses the full 181830
# fixture while owning a fresh, disposable local cluster on every run.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

export STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS="$ROOT_DIR/supabase/migrations/20260718183500_harden_stripe_entitlement_null_validation.sql:$ROOT_DIR/supabase/migrations/20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql"
export STRIPE_ENTITLEMENT_EXTRA_PROOF_SQLS="$ROOT_DIR/supabase/migrations/__tests__/stripe-entitlement-null-hardening.fixture.psql:$ROOT_DIR/supabase/migrations/__tests__/stripe-lifetime-terminal-corrections.fixture.psql"

"$ROOT_DIR/supabase/migrations/__tests__/atomic-stripe-entitlement-identity.pg17.sh"

echo "Stripe lifetime terminal corrections PREDEPLOY PostgreSQL 17 proof passed"
