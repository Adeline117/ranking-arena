#!/usr/bin/env bash

# Disposable PostgreSQL 17 proof for the Stripe webhook event identity and
# lease fence. No production connection or credential is read.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260729075000_stripe_webhook_event_lease_authority.sql"
PG17_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
INITDB="$PG17_BIN/initdb"
PG_CTL="$PG17_BIN/pg_ctl"
PSQL="$PG17_BIN/psql"

for executable in "$INITDB" "$PG_CTL" "$PSQL"; do
  if [[ ! -x "$executable" ]]; then
    echo "PostgreSQL 17 executable is missing: $executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/stripe-webhook-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
SERVER_LOG="$TMP_ROOT/postgres.log"
PORT=$((41000 + ($$ % 18000)))
mkdir -p "$SOCKET_DIR"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -d "$DATA_DIR" ]]; then
    "$PG_CTL" -D "$DATA_DIR" -m immediate stop >/dev/null 2>&1 || true
  fi
  if ((status != 0)) && [[ -f "$SERVER_LOG" ]]; then
    echo 'PostgreSQL 17 server log tail:' >&2
    tail -80 "$SERVER_LOG" >&2
  fi
  rm -rf "$TMP_ROOT"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "STRIPE WEBHOOK PG17 FAIL: $*" >&2
  exit 1
}

assert_equal() {
  local expected="$1"
  local actual="$2"
  local context="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail "$context (expected '$expected', got '$actual')"
  fi
}

"$INITDB" -D "$DATA_DIR" -U postgres --auth=trust --no-locale \
  --encoding=UTF8 >/dev/null
"$PG_CTL" -D "$DATA_DIR" -l "$SERVER_LOG" \
  -o "-F -k $SOCKET_DIR -p $PORT -c listen_addresses=''" \
  -w start >/dev/null

psql_base() {
  "$PSQL" -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres \
    -X -q -v ON_ERROR_STOP=1 "$@"
}

psql_query() {
  psql_base -Atc "$1"
}

psql_base <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE authenticator NOLOGIN;

CREATE TABLE public.stripe_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'processed', 'failed')),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  started_at timestamptz,
  last_error text,
  CONSTRAINT uq_stripe_events_event_id UNIQUE (event_id)
);

ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.claim_stripe_event(
  p_event_id text,
  p_event_type text,
  p_stale_after interval DEFAULT interval '10 minutes'
)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT 'legacy-stub'::text $$;

CREATE FUNCTION public.finish_stripe_event(
  p_event_id text,
  p_succeeded boolean,
  p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT false $$;

ALTER FUNCTION public.claim_stripe_event(text, text, interval)
  OWNER TO postgres;
ALTER FUNCTION public.finish_stripe_event(text, boolean, text)
  OWNER TO postgres;
SQL

echo 'PG17: installing additive exact-mode lease authority'
psql_base -f "$MIGRATION"

assert_equal 'true|false|false' "$(psql_query \
  "SELECT pg_catalog.has_function_privilege('service_role', 'public.claim_stripe_event_v2(text,text,boolean,interval)', 'EXECUTE') || '|' || pg_catalog.has_function_privilege('authenticated', 'public.claim_stripe_event_v2(text,text,boolean,interval)', 'EXECUTE') || '|' || pg_catalog.has_function_privilege('anon', 'public.finish_stripe_event_v2(text,text,boolean,uuid,boolean,text)', 'EXECUTE');")" \
  'v2 RPC grants'

echo 'PG17: test and live events with the same Stripe ID remain independent'
TEST_TOKEN="$(psql_query \
  "SET ROLE service_role; SELECT public.claim_stripe_event_v2('evt_shared_mode', 'invoice.paid', false)->>'leaseToken';")"
[[ "$TEST_TOKEN" =~ ^[0-9a-f-]{36}$ ]] || fail 'test-mode lease token is malformed'
assert_equal 'processed' "$(psql_query \
  "SET ROLE service_role; SELECT public.finish_stripe_event_v2('evt_shared_mode', 'invoice.paid', false, '$TEST_TOKEN'::uuid, true)->>'status';")" \
  'test-mode completion'
LIVE_TOKEN="$(psql_query \
  "SET ROLE service_role; SELECT public.claim_stripe_event_v2('evt_shared_mode', 'invoice.paid', true)->>'leaseToken';")"
[[ "$LIVE_TOKEN" =~ ^[0-9a-f-]{36}$ ]] || fail 'live-mode lease token is malformed'
[[ "$LIVE_TOKEN" != "$TEST_TOKEN" ]] || fail 'test/live claims reused a lease token'
assert_equal 'processed' "$(psql_query \
  "SET ROLE service_role; SELECT public.finish_stripe_event_v2('evt_shared_mode', 'invoice.paid', true, '$LIVE_TOKEN'::uuid, true)->>'status';")" \
  'live-mode completion'
assert_equal '2|1|1' "$(psql_query \
  "SELECT count(*) || '|' || count(*) FILTER (WHERE NOT livemode) || '|' || count(*) FILTER (WHERE livemode) FROM public.stripe_events WHERE event_id = 'evt_shared_mode';")" \
  'test/live event isolation'

echo 'PG17: event type cannot drift through a retry or direct mutation'
TYPE_TOKEN="$(psql_query \
  "SET ROLE service_role; SELECT public.claim_stripe_event_v2('evt_type_immutable', 'invoice.paid', true)->>'leaseToken';")"
TYPE_CONFLICT="$(psql_query \
  "SET ROLE service_role; SELECT public.claim_stripe_event_v2('evt_type_immutable', 'invoice.payment_failed', true)->>'status';")"
assert_equal 'identity_conflict|invoice.paid' "$TYPE_CONFLICT|$(psql_query \
  "SELECT event_type FROM public.stripe_events WHERE event_id = 'evt_type_immutable' AND livemode;")" \
  'claim event type immutability'
set +e
psql_base -c \
  "UPDATE public.stripe_events SET event_type = 'invoice.payment_failed' WHERE event_id = 'evt_type_immutable' AND livemode;" \
  >"$TMP_ROOT/type-mutation.log" 2>&1
TYPE_MUTATION_STATUS=$?
set -e
[[ "$TYPE_MUTATION_STATUS" -ne 0 ]] || fail 'direct event type mutation unexpectedly succeeded'
grep -F -q 'Stripe webhook event identity is immutable' "$TMP_ROOT/type-mutation.log" \
  || fail 'direct event type mutation did not hit the identity guard'
assert_equal 'processed' "$(psql_query \
  "SET ROLE service_role; SELECT public.finish_stripe_event_v2('evt_type_immutable', 'invoice.paid', true, '$TYPE_TOKEN'::uuid, true)->>'status';")" \
  'immutable event completion'

echo 'PG17: an expired processing lease is reclaimed with a new generation'
STALE_TOKEN="$(psql_query \
  "SET ROLE service_role; SELECT public.claim_stripe_event_v2('evt_stale_worker', 'charge.refunded', true)->>'leaseToken';")"
psql_query \
  "UPDATE public.stripe_events SET lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second' WHERE event_id = 'evt_stale_worker' AND livemode;" \
  >/dev/null
CURRENT_TOKEN="$(psql_query \
  "SET ROLE service_role; SELECT public.claim_stripe_event_v2('evt_stale_worker', 'charge.refunded', true)->>'leaseToken';")"
[[ "$CURRENT_TOKEN" != "$STALE_TOKEN" ]] || fail 'expired claim reused its lease token'
assert_equal '2|processing' "$(psql_query \
  "SELECT attempts || '|' || status FROM public.stripe_events WHERE event_id = 'evt_stale_worker' AND livemode;")" \
  'expired lease reclaim state'
assert_equal 'lease_lost' "$(psql_query \
  "SET ROLE service_role; SELECT public.finish_stripe_event_v2('evt_stale_worker', 'charge.refunded', true, '$STALE_TOKEN'::uuid, false, 'stale worker failed')->>'status';")" \
  'stale worker completion fence'
assert_equal "$CURRENT_TOKEN|processing" "$(psql_query \
  "SELECT lease_token || '|' || status FROM public.stripe_events WHERE event_id = 'evt_stale_worker' AND livemode;")" \
  'stale worker did not overwrite the current claim'
assert_equal 'processed' "$(psql_query \
  "SET ROLE service_role; SELECT public.finish_stripe_event_v2('evt_stale_worker', 'charge.refunded', true, '$CURRENT_TOKEN'::uuid, true)->>'status';")" \
  'current lease completion'

echo 'PG17: handler failure remains immediately retryable'
FAILED_TOKEN="$(psql_query \
  "SET ROLE service_role; SELECT public.claim_stripe_event_v2('evt_failure_retry', 'checkout.session.completed', false)->>'leaseToken';")"
assert_equal 'retry_scheduled' "$(psql_query \
  "SET ROLE service_role; SELECT public.finish_stripe_event_v2('evt_failure_retry', 'checkout.session.completed', false, '$FAILED_TOKEN'::uuid, false, 'temporary database outage')->>'status';")" \
  'failure state completion'
assert_equal 'failed|temporary database outage|true' "$(psql_query \
  "SELECT status || '|' || last_error || '|' || (lease_token IS NULL) FROM public.stripe_events WHERE event_id = 'evt_failure_retry' AND NOT livemode;")" \
  'retryable failure persistence'
RETRY_TOKEN="$(psql_query \
  "SET ROLE service_role; SELECT public.claim_stripe_event_v2('evt_failure_retry', 'checkout.session.completed', false)->>'leaseToken';")"
[[ "$RETRY_TOKEN" != "$FAILED_TOKEN" ]] || fail 'failed retry reused its lease token'
RETRY_FINISH="$(psql_query \
  "SET ROLE service_role; SELECT public.finish_stripe_event_v2('evt_failure_retry', 'checkout.session.completed', false, '$RETRY_TOKEN'::uuid, true)->>'status';")"
assert_equal '2|processed' "$(psql_query \
  "SELECT attempts FROM public.stripe_events WHERE event_id = 'evt_failure_retry' AND NOT livemode;")|$RETRY_FINISH" \
  'failure retry completion'

echo 'PG17: legacy RPCs remain callable and fail closed around v2 ownership'
assert_equal 'claimed|true|claimed' "$(psql_query \
  "SET ROLE service_role; SELECT public.claim_stripe_event('evt_legacy_retry', 'invoice.payment_failed') || '|' || public.finish_stripe_event('evt_legacy_retry', false, 'legacy failure') || '|' || public.claim_stripe_event('evt_legacy_retry', 'invoice.payment_failed');")" \
  'legacy failed claim retry'
assert_equal 'busy' "$(psql_query \
  "SET ROLE service_role; SELECT public.claim_stripe_event_v2('evt_legacy_retry', 'invoice.payment_failed', false)->>'status';")" \
  'v2 respects a fresh legacy claim'
assert_equal 't' "$(psql_query \
  "SET ROLE service_role; SELECT public.finish_stripe_event('evt_legacy_retry', false, 'legacy retry failed');")" \
  'legacy retry failure completion'
PROMOTED_TOKEN="$(psql_query \
  "SET ROLE service_role; SELECT public.claim_stripe_event_v2('evt_legacy_retry', 'invoice.payment_failed', false)->>'leaseToken';")"
assert_equal 'false|3|processing' "$(psql_query \
  "SELECT livemode || '|' || attempts || '|' || status FROM public.stripe_events WHERE event_id = 'evt_legacy_retry';")" \
  'legacy failure promotion to exact mode'
assert_equal 'processed' "$(psql_query \
  "SET ROLE service_role; SELECT public.finish_stripe_event_v2('evt_legacy_retry', 'invoice.payment_failed', false, '$PROMOTED_TOKEN'::uuid, true)->>'status';")" \
  'promoted legacy retry completion'
assert_equal 'busy' "$(psql_query \
  "SET ROLE service_role; SELECT public.claim_stripe_event('evt_legacy_retry', 'invoice.payment_failed');")" \
  'legacy worker fails closed on exact identity'

assert_equal 'claimed|true|processed' "$(psql_query \
  "SET ROLE service_role; SELECT public.claim_stripe_event('evt_legacy_processed', 'customer.subscription.updated') || '|' || public.finish_stripe_event('evt_legacy_processed', true, NULL) || '|' || (public.claim_stripe_event_v2('evt_legacy_processed', 'customer.subscription.updated', true)->>'status');")" \
  'v2 honors a processed rolling legacy event'

echo 'STRIPE WEBHOOK PG17 PASS: mode isolation, immutable type, lease fencing, expiry reclaim, failure retry, and rolling compatibility hold'
