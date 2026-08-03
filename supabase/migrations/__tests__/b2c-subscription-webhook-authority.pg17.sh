#!/usr/bin/env bash

# PostgreSQL 17 proof for B2C webhook authority, immutable recovery payment
# windows, and the exact owner-only lifecycle locator shared by all products.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_HARNESS="$ROOT_DIR/supabase/migrations/__tests__/atomic-stripe-entitlement-identity.pg17.sh"

SETUPS=(
  "$ROOT_DIR/supabase/migrations/__tests__/durable-tip-completion-notification.pre-setup.psql"
  "$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.setup.psql"
  "$ROOT_DIR/supabase/migrations/__tests__/durable-tip-completion-notification.setup.psql"
  "$ROOT_DIR/supabase/migrations/__tests__/tip-checkout-lifecycle.setup.psql"
  "$ROOT_DIR/supabase/migrations/__tests__/b2c-subscription-webhook-authority.setup.psql"
  "$ROOT_DIR/supabase/migrations/__tests__/b2c-subscription-webhook-authority.ledger.setup.psql"
)

MIGRATIONS=(
  "$ROOT_DIR/supabase/migrations/20260718183500_harden_stripe_entitlement_null_validation.sql"
  "$ROOT_DIR/supabase/migrations/20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql"
  "$ROOT_DIR/supabase/migrations/20260718184500_classify_non_entitlement_stripe_payments.sql"
  "$ROOT_DIR/supabase/migrations/20260718184550_durable_tip_completion_notification.sql"
  "$ROOT_DIR/supabase/migrations/20260721210000_tip_checkout_lifecycle_atomic.sql"
  "$ROOT_DIR/supabase/migrations/20260721211000_tip_checkout_completion_identity.sql"
  "$ROOT_DIR/supabase/migrations/20260729022000_account_deletion_one_time_settlement_barrier.sql"
  "$ROOT_DIR/supabase/migrations/20260729022500_account_recovery_admission_state_machine.sql"
  "$ROOT_DIR/supabase/migrations/20260729023000_preserve_financial_owner_after_account_deletion.sql"
  "$ROOT_DIR/supabase/migrations/20260729072000_account_recovery_auth_finalization.sql"
  "$ROOT_DIR/supabase/migrations/20260729073000_pro_membership_checkout_reservation.sql"
  "$ROOT_DIR/supabase/migrations/20260729074000_b2c_subscription_webhook_authority.sql"
)

join_by_colon() {
  local IFS=:
  printf '%s' "$*"
}

export STRIPE_ENTITLEMENT_EXTRA_SETUP_SQLS="$(join_by_colon "${SETUPS[@]}")"
export STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS="$(join_by_colon "${MIGRATIONS[@]}")"
export STRIPE_ENTITLEMENT_EXTRA_PROOF_SQLS="$ROOT_DIR/supabase/migrations/__tests__/b2c-subscription-webhook-authority.fixture.psql"
export STRIPE_ENTITLEMENT_SKIP_BASE_PROOF=1

exec "$BASE_HARNESS"
