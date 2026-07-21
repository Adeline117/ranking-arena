#!/usr/bin/env bash

# PostgreSQL 17 proof for the exact 181830 -> 181835 -> 181836 -> 181845 ->
# 18184550 tip chain. It first proves that the production uuid reference shape
# fails closed against a text-shaped shadow, then runs the clean chain and a
# deterministic two-session refund race.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_HARNESS="$ROOT_DIR/supabase/migrations/__tests__/atomic-stripe-entitlement-identity.pg17.sh"
NON_ENTITLEMENT_SETUP="$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.setup.psql"
NOTIFICATION_PRE_SETUP="$ROOT_DIR/supabase/migrations/__tests__/durable-tip-completion-notification.pre-setup.psql"
NOTIFICATION_SETUP="$ROOT_DIR/supabase/migrations/__tests__/durable-tip-completion-notification.setup.psql"
REFERENCE_DRIFT="$ROOT_DIR/supabase/migrations/__tests__/durable-tip-completion-notification.reference-drift.psql"
OWNERSHIP_DRIFT="$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.drift.psql"
MIGRATION_181835="$ROOT_DIR/supabase/migrations/20260718183500_harden_stripe_entitlement_null_validation.sql"
MIGRATION_181836="$ROOT_DIR/supabase/migrations/20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql"
MIGRATION_181845="$ROOT_DIR/supabase/migrations/20260718184500_classify_non_entitlement_stripe_payments.sql"
MIGRATION_18184550="$ROOT_DIR/supabase/migrations/20260718184550_durable_tip_completion_notification.sql"
FIXTURE="$ROOT_DIR/supabase/migrations/__tests__/durable-tip-completion-notification.fixture.psql"
CONCURRENCY="$ROOT_DIR/supabase/migrations/__tests__/durable-tip-completion-notification.concurrency.pg17.sh"
FAILURE_LOG="$(mktemp /tmp/durable-tip-notification-preflight.XXXXXX.log)"

cleanup() {
  rm -f "$FAILURE_LOG"
}
trap cleanup EXIT

SETUP_CHAIN="$NOTIFICATION_PRE_SETUP:$NON_ENTITLEMENT_SETUP:$NOTIFICATION_SETUP"
MIGRATION_CHAIN="$MIGRATION_181835:$MIGRATION_181836:$OWNERSHIP_DRIFT:$MIGRATION_181845:$MIGRATION_18184550"

if STRIPE_ENTITLEMENT_EXTRA_SETUP_SQLS="$SETUP_CHAIN:$REFERENCE_DRIFT" \
  STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS="$MIGRATION_CHAIN" \
  "$BASE_HARNESS" >"$FAILURE_LOG" 2>&1; then
  echo "text reference_id shadow unexpectedly passed 18184550 preflight" >&2
  exit 1
fi
if ! grep -Fq \
  'durable tip notification column shape is incompatible: notifications.reference_id' \
  "$FAILURE_LOG"; then
  echo "text reference_id shadow failed for an unexpected reason" >&2
  sed -n '1,160p' "$FAILURE_LOG" >&2
  exit 1
fi

export STRIPE_ENTITLEMENT_EXTRA_SETUP_SQLS="$SETUP_CHAIN"
export STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS="$MIGRATION_CHAIN"
export STRIPE_ENTITLEMENT_EXTRA_PROOF_SQLS="$FIXTURE"
export STRIPE_ENTITLEMENT_EXTRA_PROOF_SHELLS="$CONCURRENCY"

"$BASE_HARNESS"

echo "Durable tip completion notification PREDEPLOY PostgreSQL 17 proof passed"
