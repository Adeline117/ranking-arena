#!/usr/bin/env bash

# PostgreSQL 17 integration proof for the additive Stripe entitlement NULL
# validation hardening. It reuses the full 181830 fixture while still owning a
# fresh, disposable local cluster on every run.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

export STRIPE_ENTITLEMENT_EXTRA_MIGRATION="$ROOT_DIR/supabase/migrations/20260718183500_harden_stripe_entitlement_null_validation.sql"
export STRIPE_ENTITLEMENT_EXTRA_PROOF_SQL="$ROOT_DIR/supabase/migrations/__tests__/stripe-entitlement-null-hardening.fixture.psql"

"$ROOT_DIR/supabase/migrations/__tests__/atomic-stripe-entitlement-identity.pg17.sh"

echo "Stripe entitlement NULL validation PREDEPLOY PostgreSQL 17 proof passed"
