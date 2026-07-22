#!/usr/bin/env bash

# PostgreSQL 17 proof for durable Tip reservation, exact Stripe Session binding,
# signed expiry provenance, managed-auth ownership, and concurrency.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_HARNESS="$ROOT_DIR/supabase/migrations/__tests__/atomic-stripe-entitlement-identity.pg17.sh"
NON_ENTITLEMENT_SETUP="$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.setup.psql"
NOTIFICATION_PRE_SETUP="$ROOT_DIR/supabase/migrations/__tests__/durable-tip-completion-notification.pre-setup.psql"
NOTIFICATION_SETUP="$ROOT_DIR/supabase/migrations/__tests__/durable-tip-completion-notification.setup.psql"
LIFECYCLE_SETUP="$ROOT_DIR/supabase/migrations/__tests__/tip-checkout-lifecycle.setup.psql"
OWNERSHIP_DRIFT="$ROOT_DIR/supabase/migrations/__tests__/non-entitlement-stripe-ownership.drift.psql"
MIGRATION_181835="$ROOT_DIR/supabase/migrations/20260718183500_harden_stripe_entitlement_null_validation.sql"
MIGRATION_181836="$ROOT_DIR/supabase/migrations/20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql"
MIGRATION_181845="$ROOT_DIR/supabase/migrations/20260718184500_classify_non_entitlement_stripe_payments.sql"
MIGRATION_18184550="$ROOT_DIR/supabase/migrations/20260718184550_durable_tip_completion_notification.sql"
MIGRATION_21210000="$ROOT_DIR/supabase/migrations/20260721210000_tip_checkout_lifecycle_atomic.sql"
MIGRATION_21211000="$ROOT_DIR/supabase/migrations/20260721211000_tip_checkout_completion_identity.sql"
DUPLICATE_DRIFT="$ROOT_DIR/supabase/migrations/__tests__/tip-checkout-lifecycle.duplicate-drift.psql"
AUTH_DRIFT="$ROOT_DIR/supabase/migrations/__tests__/tip-checkout-lifecycle.auth-select-only-drift.psql"
AUTH_MODE="$ROOT_DIR/supabase/migrations/__tests__/tip-checkout-lifecycle.managed-auth-mode.psql"
AUTH_BYPASS_DRIFT="$ROOT_DIR/supabase/migrations/__tests__/tip-checkout-lifecycle.auth-no-bypass-drift.psql"
RESTORE_POSTGRES="$ROOT_DIR/supabase/migrations/__tests__/tip-checkout-lifecycle.restore-postgres-super.psql"
FIXTURE="$ROOT_DIR/supabase/migrations/__tests__/tip-checkout-lifecycle.fixture.psql"
CONCURRENCY="$ROOT_DIR/supabase/migrations/__tests__/tip-checkout-lifecycle.concurrency.pg17.sh"
FAILURE_LOG="$(mktemp /tmp/tip-checkout-lifecycle-preflight.XXXXXX)"
EXACT_LEDGER_SETUP="$(mktemp /tmp/tip-checkout-lifecycle-ledger-exact.XXXXXX)"
DRIFTED_LEDGER_SETUP="$(mktemp /tmp/tip-checkout-lifecycle-ledger-drift.XXXXXX)"
LIFECYCLE_SHA256='d10a9959b52e20d127553c1683b154a62c97d85c455ff12e831c3a1d5c7ef1ab'

cleanup() {
  rm -f "$FAILURE_LOG" "$EXACT_LEDGER_SETUP" "$DRIFTED_LEDGER_SETUP"
}
trap cleanup EXIT

if [[ "$(shasum -a 256 "$MIGRATION_21210000" | awk '{print $1}')" != \
  "$LIFECYCLE_SHA256" ]]; then
  echo "Tip checkout lifecycle fixture hash drifted" >&2
  exit 1
fi

write_ledger_schema() {
  printf '%s\n' \
    'CREATE SCHEMA extensions AUTHORIZATION postgres;' \
    'CREATE EXTENSION pgcrypto WITH SCHEMA extensions;' \
    'CREATE SCHEMA supabase_migrations AUTHORIZATION postgres;' \
    'CREATE TABLE supabase_migrations.schema_migrations (' \
    '  version text PRIMARY KEY,' \
    '  statements text[] NOT NULL,' \
    '  name text NOT NULL,' \
    '  created_by text NOT NULL,' \
    '  idempotency_key text NOT NULL' \
    ');'
}

{
  write_ledger_schema
  printf '%s' \
    "INSERT INTO supabase_migrations.schema_migrations" \
    " (version, statements, name, created_by, idempotency_key)" \
    " VALUES ('20260721210000', ARRAY[\$tip_lifecycle_exact_body\$"
  perl -0pe '' "$MIGRATION_21210000"
  printf '%s\n' \
    "\$tip_lifecycle_exact_body\$]::text[]," \
    " 'tip_checkout_lifecycle_atomic', 'codex'," \
    " 'codex:20260721210000:$LIFECYCLE_SHA256');"
} >"$EXACT_LEDGER_SETUP"

{
  write_ledger_schema
  printf '%s\n' \
    'INSERT INTO supabase_migrations.schema_migrations' \
    '  (version, statements, name, created_by, idempotency_key)' \
    "VALUES ('20260721210000', ARRAY['drifted lifecycle body']::text[]," \
    "  'tip_checkout_lifecycle_atomic', 'codex'," \
    "  'codex:20260721210000:$LIFECYCLE_SHA256');"
} >"$DRIFTED_LEDGER_SETUP"

SETUP_CHAIN="$NOTIFICATION_PRE_SETUP:$NON_ENTITLEMENT_SETUP:$NOTIFICATION_SETUP:$LIFECYCLE_SETUP"
BASE_MIGRATION_CHAIN="$MIGRATION_181835:$MIGRATION_181836:$OWNERSHIP_DRIFT:$MIGRATION_181845:$MIGRATION_18184550:$AUTH_MODE"

if STRIPE_ENTITLEMENT_EXTRA_SETUP_SQLS="$SETUP_CHAIN" \
  STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS="$BASE_MIGRATION_CHAIN:$DUPLICATE_DRIFT:$MIGRATION_21210000" \
  "$BASE_HARNESS" >"$FAILURE_LOG" 2>&1; then
  echo "duplicate pending Tip reservations unexpectedly passed preflight" >&2
  exit 1
fi
if ! grep -Fq \
  'duplicate pending Tip checkout reservations require explicit review' \
  "$FAILURE_LOG"; then
  echo "duplicate reservation preflight failed for an unexpected reason" >&2
  sed -n '1,180p' "$FAILURE_LOG" >&2
  exit 1
fi

if STRIPE_ENTITLEMENT_EXTRA_SETUP_SQLS="$SETUP_CHAIN" \
  STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS="$BASE_MIGRATION_CHAIN:$MIGRATION_21210000:$MIGRATION_21211000" \
  "$BASE_HARNESS" >"$FAILURE_LOG" 2>&1; then
  echo "Tip completion identity unexpectedly accepted a missing lifecycle ledger" >&2
  exit 1
fi
if ! grep -Fq \
  'Tip completion identity requires the exact 20260721210000 migration ledger' \
  "$FAILURE_LOG"; then
  echo "missing lifecycle ledger preflight failed for an unexpected reason" >&2
  sed -n '1,180p' "$FAILURE_LOG" >&2
  exit 1
fi

if STRIPE_ENTITLEMENT_EXTRA_SETUP_SQLS="$SETUP_CHAIN" \
  STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS="$BASE_MIGRATION_CHAIN:$MIGRATION_21210000:$DRIFTED_LEDGER_SETUP:$MIGRATION_21211000" \
  "$BASE_HARNESS" >"$FAILURE_LOG" 2>&1; then
  echo "Tip completion identity unexpectedly accepted a drifted lifecycle ledger" >&2
  exit 1
fi
if ! grep -Fq \
  'Tip completion identity requires the exact 20260721210000 migration ledger' \
  "$FAILURE_LOG"; then
  echo "drifted lifecycle ledger preflight failed for an unexpected reason" >&2
  sed -n '1,180p' "$FAILURE_LOG" >&2
  exit 1
fi

if STRIPE_ENTITLEMENT_EXTRA_SETUP_SQLS="$SETUP_CHAIN" \
  STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS="$BASE_MIGRATION_CHAIN:$AUTH_DRIFT:$MIGRATION_21210000" \
  "$BASE_HARNESS" >"$FAILURE_LOG" 2>&1; then
  echo "SELECT-only managed auth authority unexpectedly passed preflight" >&2
  exit 1
fi
if ! grep -Fq \
  'auth.users must retain hosted ownership and postgres row-lock authority' \
  "$FAILURE_LOG"; then
  echo "managed-auth privilege preflight failed for an unexpected reason" >&2
  sed -n '1,180p' "$FAILURE_LOG" >&2
  exit 1
fi

if STRIPE_ENTITLEMENT_EXTRA_SETUP_SQLS="$SETUP_CHAIN" \
  STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS="$BASE_MIGRATION_CHAIN:$AUTH_BYPASS_DRIFT:$MIGRATION_21210000" \
  "$BASE_HARNESS" >"$FAILURE_LOG" 2>&1; then
  echo "managed auth without BYPASSRLS unexpectedly passed preflight" >&2
  exit 1
fi
if ! grep -Fq \
  'auth.users must retain hosted ownership and postgres row-lock authority' \
  "$FAILURE_LOG"; then
  echo "managed-auth visibility preflight failed for an unexpected reason" >&2
  sed -n '1,180p' "$FAILURE_LOG" >&2
  exit 1
fi

export STRIPE_ENTITLEMENT_EXTRA_SETUP_SQLS="$SETUP_CHAIN"
export STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS="$BASE_MIGRATION_CHAIN:$MIGRATION_21210000:$EXACT_LEDGER_SETUP:$MIGRATION_21211000:$RESTORE_POSTGRES"
export STRIPE_ENTITLEMENT_EXTRA_PROOF_SQLS="$FIXTURE"
export STRIPE_ENTITLEMENT_EXTRA_PROOF_SHELLS="$CONCURRENCY"

"$BASE_HARNESS"

echo "Tip checkout lifecycle PREDEPLOY PostgreSQL 17 proof passed"
