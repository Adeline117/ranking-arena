#!/usr/bin/env bash

# PostgreSQL 17 proof for preserving exact Tip/Pro financial ownership across
# auth/profile hard deletion and routing later refunds without display PII.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_HARNESS="$ROOT_DIR/supabase/migrations/__tests__/atomic-stripe-entitlement-identity.pg17.sh"
SETUP="$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.setup.psql"
MIGRATION_181835="$ROOT_DIR/supabase/migrations/20260718183500_harden_stripe_entitlement_null_validation.sql"
MIGRATION_181836="$ROOT_DIR/supabase/migrations/20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql"
OWNERSHIP_DRIFT="$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.drift.psql"
MIGRATION_181845="$ROOT_DIR/supabase/migrations/20260718184500_classify_non_entitlement_stripe_payments.sql"
MIGRATION_211400="$ROOT_DIR/supabase/migrations/20260721140000_idempotent_equivalent_refund_events.sql"
PRE_MIGRATION_FIXTURE="$ROOT_DIR/supabase/migrations/__tests__/financial-subject-retention.pre-migration.psql"
MIGRATION_290230="$ROOT_DIR/supabase/migrations/20260729023000_preserve_financial_owner_after_account_deletion.sql"
FIXTURE="$ROOT_DIR/supabase/migrations/__tests__/financial-subject-retention.fixture.psql"

export STRIPE_ENTITLEMENT_EXTRA_SETUP_SQL="$SETUP"
export STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS="$MIGRATION_181835:$MIGRATION_181836:$OWNERSHIP_DRIFT:$MIGRATION_181845:$MIGRATION_211400:$PRE_MIGRATION_FIXTURE:$MIGRATION_290230"
export STRIPE_ENTITLEMENT_EXTRA_PROOF_SQL="$FIXTURE"

"$BASE_HARNESS"

echo "Financial-subject retention PostgreSQL 17 proof passed"
