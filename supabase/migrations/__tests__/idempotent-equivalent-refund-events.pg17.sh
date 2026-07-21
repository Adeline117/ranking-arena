#!/usr/bin/env bash

# PostgreSQL 17 proof for unordered Stripe refund-event wakeups over the exact
# 181835 -> 181836 -> 181845 -> 18184550 -> 21140000 production chain.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_HARNESS="$ROOT_DIR/supabase/migrations/__tests__/atomic-stripe-entitlement-identity.pg17.sh"
NON_ENTITLEMENT_SETUP="$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.setup.psql"
NOTIFICATION_PRE_SETUP="$ROOT_DIR/supabase/migrations/__tests__/durable-tip-completion-notification.pre-setup.psql"
NOTIFICATION_SETUP="$ROOT_DIR/supabase/migrations/__tests__/durable-tip-completion-notification.setup.psql"
OWNERSHIP_DRIFT="$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.drift.psql"
MIGRATION_181835="$ROOT_DIR/supabase/migrations/20260718183500_harden_stripe_entitlement_null_validation.sql"
MIGRATION_181836="$ROOT_DIR/supabase/migrations/20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql"
MIGRATION_181845="$ROOT_DIR/supabase/migrations/20260718184500_classify_non_entitlement_stripe_payments.sql"
MIGRATION_18184550="$ROOT_DIR/supabase/migrations/20260718184550_durable_tip_completion_notification.sql"
MIGRATION_21140000="$ROOT_DIR/supabase/migrations/20260721140000_idempotent_equivalent_refund_events.sql"
FIXTURE="$ROOT_DIR/supabase/migrations/__tests__/idempotent-equivalent-refund-events.fixture.psql"

export STRIPE_ENTITLEMENT_EXTRA_SETUP_SQLS="$NOTIFICATION_PRE_SETUP:$NON_ENTITLEMENT_SETUP:$NOTIFICATION_SETUP"
export STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS="$MIGRATION_181835:$MIGRATION_181836:$OWNERSHIP_DRIFT:$MIGRATION_181845:$MIGRATION_18184550:$MIGRATION_21140000"
export STRIPE_ENTITLEMENT_EXTRA_PROOF_SQLS="$FIXTURE"

"$BASE_HARNESS"

echo "idempotent equivalent refund events PREDEPLOY PostgreSQL 17 proof passed"

