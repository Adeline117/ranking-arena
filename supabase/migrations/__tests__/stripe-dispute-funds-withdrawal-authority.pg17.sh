#!/usr/bin/env bash

# PostgreSQL 17 proof for warning-inquiry isolation and idempotent Stripe
# created/funds_withdrawn authority in real predeploy/postdeploy order.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_HARNESS="$ROOT_DIR/supabase/migrations/__tests__/atomic-stripe-entitlement-identity.pg17.sh"
NOTIFICATION_PRE_SETUP="$ROOT_DIR/supabase/migrations/__tests__/durable-tip-completion-notification.pre-setup.psql"
NON_ENTITLEMENT_SETUP="$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.setup.psql"
NOTIFICATION_SETUP="$ROOT_DIR/supabase/migrations/__tests__/durable-tip-completion-notification.setup.psql"
API_SETUP="$ROOT_DIR/supabase/migrations/__tests__/api-tier-payment-reversals.setup.psql"
REINSTATEMENT_SETUP="$ROOT_DIR/supabase/migrations/__tests__/stripe-dispute-funds-reinstatement.setup.psql"
MIGRATION_181835="$ROOT_DIR/supabase/migrations/20260718183500_harden_stripe_entitlement_null_validation.sql"
MIGRATION_181836="$ROOT_DIR/supabase/migrations/20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql"
MIGRATION_181845="$ROOT_DIR/supabase/migrations/20260718184500_classify_non_entitlement_stripe_payments.sql"
MIGRATION_18184550="$ROOT_DIR/supabase/migrations/20260718184550_durable_tip_completion_notification.sql"
MIGRATION_211400="$ROOT_DIR/supabase/migrations/20260721140000_idempotent_equivalent_refund_events.sql"
MIGRATION_290100="$ROOT_DIR/supabase/migrations/20260729010000_api_keys_server_authority.sql"
MIGRATION_290200="$ROOT_DIR/supabase/migrations/20260729020000_api_tier_cancellation_identity.sql"
MIGRATION_290230="$ROOT_DIR/supabase/migrations/20260729023000_preserve_financial_owner_after_account_deletion.sql"
MIGRATION_290240="$ROOT_DIR/supabase/migrations/20260729024000_api_tier_payment_reversals.sql"
MIGRATION_290650="$ROOT_DIR/supabase/migrations/20260729065000_stripe_entitlement_livemode_authority.sql"
MIGRATION_290660="$ROOT_DIR/supabase/migrations/20260729066000_stripe_charge_dispute_authority.sql"
MIGRATION_290690="$ROOT_DIR/supabase/migrations/20260729069000_stripe_dispute_funds_reinstatement.sql"
MIGRATION_290720="$ROOT_DIR/supabase/migrations/20260729072000_stripe_refund_retry_authority.sql"
MIGRATION_290730="$ROOT_DIR/supabase/migrations/20260729073000_stripe_dispute_funds_withdrawal_authority.sql"
FIXTURE="$ROOT_DIR/supabase/migrations/__tests__/stripe-dispute-funds-withdrawal-authority.fixture.psql"

export STRIPE_ENTITLEMENT_EXTRA_SETUP_SQLS="$NOTIFICATION_PRE_SETUP:$NON_ENTITLEMENT_SETUP:$NOTIFICATION_SETUP:$API_SETUP:$REINSTATEMENT_SETUP"
export STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS="$MIGRATION_181835:$MIGRATION_181836:$MIGRATION_181845:$MIGRATION_18184550:$MIGRATION_211400:$MIGRATION_290100:$MIGRATION_290200:$MIGRATION_290230"
export STRIPE_ENTITLEMENT_EXTRA_PROOF_SQLS="$MIGRATION_290240:$MIGRATION_290720:$MIGRATION_290650:$MIGRATION_290660:$MIGRATION_290690:$MIGRATION_290730:$FIXTURE"

"$BASE_HARNESS"

echo "Stripe dispute funds-withdrawal authority PostgreSQL 17 proof passed"
