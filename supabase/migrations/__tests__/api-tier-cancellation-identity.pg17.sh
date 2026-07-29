#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the API-tier Stripe event ledger, ordering,
# replay, role graph, ACL convergence, and FORCE-RLS atomic rollback.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729020000_api_tier_cancellation_identity.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/api-tier-event-ledger-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55530
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    [[ -f "$LOG_FILE" ]] && tail -240 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_failure() {
  local sql="$1"
  local label="$2"
  if psql_cmd -Atqc "$sql" >/dev/null 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
}

expect_migration_failure() {
  local label="$1"
  if psql_cmd -f "$MIGRATION" >/dev/null 2>&1; then
    echo "Expected migration failure: $label" >&2
    return 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOINHERIT;
CREATE ROLE hostile_role NOLOGIN;

GRANT service_role TO authenticator
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

GRANT USAGE ON SCHEMA public
  TO anon, authenticated, service_role, authenticator, hostile_role;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  api_tier text NOT NULL DEFAULT 'free'
    CHECK (api_tier IN ('free', 'starter', 'pro')),
  api_stripe_subscription_id text,
  updated_at timestamptz
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.api_keys (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  tier text NOT NULL DEFAULT 'free'
    CHECK (tier IN ('free', 'starter', 'pro')),
  daily_limit integer NOT NULL DEFAULT 100
);
ALTER TABLE public.api_keys OWNER TO postgres;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.user_profiles, public.api_keys
  TO service_role;
CREATE POLICY service_role_manages_user_profiles
  ON public.user_profiles
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY service_role_manages_api_keys
  ON public.api_keys
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE FUNCTION public.update_user_api_tier(
  p_user_id uuid,
  p_api_tier text,
  p_stripe_subscription_id text,
  p_daily_limit integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  UPDATE public.user_profiles
  SET
    api_tier = p_api_tier,
    api_stripe_subscription_id = p_stripe_subscription_id,
    updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_user_id;

  UPDATE public.api_keys
  SET
    tier = p_api_tier,
    daily_limit = p_daily_limit
  WHERE user_id = p_user_id
    AND active;
END
$function$;
ALTER FUNCTION public.update_user_api_tier(uuid, text, text, integer)
  OWNER TO postgres;
REVOKE ALL
  ON FUNCTION public.update_user_api_tier(uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.update_user_api_tier(uuid, text, text, integer)
  TO service_role;

INSERT INTO public.user_profiles (
  id,
  api_tier,
  api_stripe_subscription_id
) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    'starter',
    'sub_base'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'free',
    NULL
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    'pro',
    'sub_historical'
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    'free',
    NULL
  ),
  (
    '10000000-0000-4000-8000-000000000005',
    'free',
    NULL
  );

INSERT INTO public.api_keys (id, user_id, active, tier, daily_limit)
VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    true,
    'starter',
    10000
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    false,
    'pro',
    0
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000002',
    true,
    'free',
    100
  ),
  (
    '20000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000003',
    true,
    'pro',
    0
  ),
  (
    '20000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000004',
    true,
    'free',
    100
  ),
  (
    '20000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000005',
    true,
    'free',
    100
  );
SQL

psql_cmd -f "$MIGRATION"

# The event authority and its owner-only ledger must not be reachable by a
# browser or arbitrary role. The old unsequenced updater is owner-only too.
for role in anon authenticated hostile_role; do
  expect_failure \
    "SET ROLE $role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'starter', 10000, 'sub_base', 100, 'evt_denied_$role', 100, true, false, true)" \
    "$role could execute the service-only Stripe event authority"
  expect_failure \
    "SET ROLE $role; SELECT * FROM public.api_tier_stripe_event_ledger" \
    "$role could read the owner-only Stripe event ledger"
done
expect_failure \
  "SET ROLE service_role; SELECT public.update_user_api_tier('10000000-0000-4000-8000-000000000001', 'pro', 'sub_forged', 0)" \
  "service_role retained the unsequenced API tier updater"

expect_failure \
  "SET ROLE service_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'free', 100, 'sub_base', 100, 'evt_bad_active', 100, true, false, true)" \
  "an active event accepted the free tier"
expect_failure \
  "SET ROLE service_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'pro', 0, 'sub_base', 100, 'evt_bad_terminal', 100, false, true, true)" \
  "a terminal event accepted a paid tier"
expect_failure \
  "SET ROLE service_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'starter', 9999, 'sub_base', 100, 'evt_bad_starter_limit', 100, true, false, true)" \
  "starter accepted a noncanonical daily limit"
expect_failure \
  "SET ROLE service_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'pro', 100, 'sub_base', 100, 'evt_bad_pro_limit', 100, true, false, true)" \
  "pro accepted a finite daily limit"
expect_failure \
  "SET ROLE service_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'free', 0, 'sub_base', 100, 'evt_bad_free_limit', 100, false, true, true)" \
  "free accepted a noncanonical daily limit"
expect_failure \
  "SET ROLE service_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'starter', 10000, 'sub_base', 100, 'evt_active_terminal', 100, true, true, true)" \
  "an event was both active and terminal"
expect_failure \
  "SET ROLE service_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'starter', 10000, 'sub_base', 101, 'evt_before_subscription', 100, true, false, true)" \
  "an event timestamp predating its subscription was accepted"
expect_failure \
  "SET ROLE service_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'starter', 10000, 'sub_base', 100, 'evt_future_subscription', 253402300800, true, false, true)" \
  "an event timestamp beyond PostgreSQL range was accepted"
expect_failure \
  "SET ROLE service_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'starter', 10000, 'sub_base', 253402300800, 'evt_future_created', 253402300800, true, false, true)" \
  "a subscription timestamp beyond PostgreSQL range was accepted"

# A historical projection may only be seeded by its exact current subscription.
expect_failure \
  "SET ROLE service_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000003', 'pro', 0, 'sub_replacement', 400, 'evt_historical_wrong', 400, true, false, true)" \
  "an unseeded historical subscription accepted a different ID"

historical_seed="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT public.apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000003',
      'pro',
      0,
      'sub_historical',
      300,
      'evt_historical_seed',
      300,
      true,
      false,
      true
    );
  "
)"
if [[ "$historical_seed" != "applied" ]]; then
  echo "Historical same-ID seed was not applied: $historical_seed" >&2
  exit 1
fi

# Seed the legacy current subscription, then activate successively newer
# subscriptions. The newest subscription.created is authoritative.
psql_cmd <<'SQL'
SET ROLE service_role;
DO $ordered_activation_proof$
DECLARE
  v_result text;
BEGIN
  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'starter',
    10000,
    'sub_base',
    100,
    'evt_base_active',
    100,
    true,
    false,
    true
  );
  IF v_result <> 'applied' THEN
    RAISE EXCEPTION 'legacy base seed result: %', v_result;
  END IF;

  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'starter',
    10000,
    'sub_middle',
    200,
    'evt_middle_active',
    200,
    true,
    false,
    true
  );
  IF v_result <> 'applied' THEN
    RAISE EXCEPTION 'middle activation result: %', v_result;
  END IF;

  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'pro',
    0,
    'sub_newest',
    300,
    'evt_newest_active',
    300,
    true,
    false,
    true
  );
  IF v_result <> 'applied' THEN
    RAISE EXCEPTION 'newest activation result: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND api_tier = 'pro'
      AND api_stripe_subscription_id = 'sub_newest'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000001'
      AND tier = 'pro'
      AND daily_limit = 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000002'
      AND tier = 'pro'
      AND daily_limit = 0
  ) THEN
    RAISE EXCEPTION 'newest active subscription projection is wrong';
  END IF;
END
$ordered_activation_proof$;
RESET ROLE;
SQL

# An older subscription can receive a newer event without replacing the newer
# subscription. Terminating that non-current subscription also preserves it.
psql_cmd <<'SQL'
SET ROLE service_role;
DO $cross_subscription_order_proof$
DECLARE
  v_result text;
BEGIN
  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'starter',
    10000,
    'sub_base',
    100,
    'evt_base_late_update',
    350,
    true,
    false,
    true
  );
  IF v_result <> 'not_current' THEN
    RAISE EXCEPTION 'older active update result: %', v_result;
  END IF;

  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'free',
    100,
    'sub_middle',
    200,
    'evt_middle_terminal',
    360,
    false,
    true,
    true
  );
  IF v_result <> 'not_current' THEN
    RAISE EXCEPTION 'older terminal result: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND api_tier = 'pro'
      AND api_stripe_subscription_id = 'sub_newest'
  ) THEN
    RAISE EXCEPTION 'late old-subscription event replaced the newest one';
  END IF;
END
$cross_subscription_order_proof$;
RESET ROLE;
SQL

# Terminating the current subscription falls back atomically to the newest
# older subscription whose terminal-sticky state is still active.
psql_cmd <<'SQL'
SET ROLE service_role;
DO $fallback_and_terminal_sticky_proof$
DECLARE
  v_result text;
BEGIN
  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'free',
    100,
    'sub_newest',
    300,
    'evt_newest_terminal',
    400,
    false,
    true,
    true
  );
  IF v_result <> 'applied' THEN
    RAISE EXCEPTION 'current terminal result: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND api_tier = 'starter'
      AND api_stripe_subscription_id = 'sub_base'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000001'
      AND tier = 'starter'
      AND daily_limit = 10000
  ) THEN
    RAISE EXCEPTION 'current terminal did not fall back to older active state';
  END IF;

  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'free',
    100,
    'sub_base',
    100,
    'evt_base_terminal',
    410,
    false,
    true,
    true
  );
  IF v_result <> 'applied' THEN
    RAISE EXCEPTION 'base terminal result: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND api_tier = 'free'
      AND api_stripe_subscription_id IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000001'
      AND tier = 'free'
      AND daily_limit = 100
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000002'
      AND tier = 'pro'
      AND daily_limit = 0
  ) THEN
    RAISE EXCEPTION 'last terminal did not atomically project free entitlement';
  END IF;

  -- Even an active event carrying a later event.created cannot resurrect a
  -- subscription after a reviewed terminal event.
  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'pro',
    0,
    'sub_newest',
    300,
    'evt_newest_impossible_reactivation',
    999,
    true,
    false,
    true
  );
  IF v_result <> 'stale' OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND api_tier = 'free'
      AND api_stripe_subscription_id IS NULL
  ) THEN
    RAISE EXCEPTION 'terminal subscription was resurrected: %', v_result;
  END IF;
END
$fallback_and_terminal_sticky_proof$;
RESET ROLE;
SQL

# Exact replay is acknowledged without a duplicate ledger row. Reusing the
# event ID with any conflicting payload fails.
replay_result="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT public.apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000001',
      'free',
      100,
      'sub_base',
      100,
      'evt_base_terminal',
      410,
      false,
      true,
      true
    );
  "
)"
if [[ "$replay_result" != "idempotent" ]]; then
  echo "Exact Stripe event replay was not idempotent: $replay_result" >&2
  exit 1
fi
expect_failure \
  "SET ROLE service_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'free', 101, 'sub_base', 100, 'evt_base_terminal', 410, false, true, true)" \
  "conflicting event-ID replay was accepted"

psql_cmd <<'SQL'
DO $replay_count_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.api_tier_stripe_event_ledger
    WHERE livemode
      AND stripe_event_id = 'evt_base_terminal'
  ) <> 1 THEN
    RAISE EXCEPTION 'exact replay duplicated the immutable event ledger';
  END IF;
END
$replay_count_proof$;
SQL

# A recoverable paused/incomplete state revokes quota immediately, ignores an
# older active delivery, and can later resume. A terminal state still cannot.
psql_cmd <<'SQL'
SET ROLE service_role;
DO $recoverable_suspension_proof$
DECLARE
  v_result text;
BEGIN
  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000005',
    'starter',
    10000,
    'sub_recoverable',
    450,
    'evt_recoverable_active',
    450,
    true,
    false,
    true
  );
  IF v_result <> 'applied' THEN
    RAISE EXCEPTION 'recoverable baseline result: %', v_result;
  END IF;

  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000005',
    'free',
    100,
    'sub_recoverable',
    450,
    'evt_recoverable_paused',
    460,
    false,
    false,
    true
  );
  IF v_result <> 'applied' OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000005'
      AND api_tier = 'free'
      AND api_stripe_subscription_id = 'sub_recoverable'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000006'
      AND tier = 'free'
      AND daily_limit = 100
  ) THEN
    RAISE EXCEPTION 'recoverable suspension did not revoke quota: %', v_result;
  END IF;

  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000005',
    'starter',
    10000,
    'sub_recoverable',
    450,
    'evt_recoverable_stale_active',
    455,
    true,
    false,
    true
  );
  IF v_result <> 'stale' THEN
    RAISE EXCEPTION 'pre-suspension active event was not stale: %', v_result;
  END IF;

  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000005',
    'starter',
    10000,
    'sub_recoverable',
    450,
    'evt_recoverable_resumed',
    470,
    true,
    false,
    true
  );
  IF v_result <> 'applied' OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000005'
      AND api_tier = 'starter'
      AND api_stripe_subscription_id = 'sub_recoverable'
  ) THEN
    RAISE EXCEPTION 'recoverable subscription did not resume: %', v_result;
  END IF;

  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000005',
    'free',
    100,
    'sub_recoverable',
    450,
    'evt_recoverable_terminal',
    480,
    false,
    true,
    true
  );
  IF v_result <> 'applied' THEN
    RAISE EXCEPTION 'recoverable terminal result: %', v_result;
  END IF;

  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000005',
    'starter',
    10000,
    'sub_recoverable',
    450,
    'evt_recoverable_after_terminal',
    490,
    true,
    false,
    true
  );
  IF v_result <> 'stale' OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000005'
      AND api_tier = 'free'
      AND api_stripe_subscription_id IS NULL
  ) THEN
    RAISE EXCEPTION 'terminal state was recoverable: %', v_result;
  END IF;
END
$recoverable_suspension_proof$;
RESET ROLE;
SQL

# Two active subscriptions with the same subscription.created cannot be
# selected deterministically. The second call and its ledger insert roll back.
tie_first="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT public.apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000002',
      'starter',
      10000,
      'sub_tie_a',
      500,
      'evt_tie_a',
      500,
      true,
      false,
      true
    );
  "
)"
if [[ "$tie_first" != "applied" ]]; then
  echo "First same-second subscription was not applied: $tie_first" >&2
  exit 1
fi
expect_failure \
  "SET ROLE service_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000002', 'pro', 0, 'sub_tie_b', 500, 'evt_tie_b', 501, true, false, true)" \
  "equally-created active subscriptions were not rejected"

# Same-subscription, same-second active payload disagreement also fails closed.
expect_failure \
  "SET ROLE service_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000002', 'pro', 0, 'sub_tie_a', 500, 'evt_tie_a_conflict', 500, true, false, true)" \
  "same-second same-subscription payload disagreement was accepted"

psql_cmd <<'SQL'
DO $tie_rollback_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.api_tier_stripe_event_ledger
    WHERE stripe_event_id IN ('evt_tie_b', 'evt_tie_a_conflict')
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000002'
      AND api_tier = 'starter'
      AND api_stripe_subscription_id = 'sub_tie_a'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000003'
      AND tier = 'starter'
      AND daily_limit = 10000
  ) THEN
    RAISE EXCEPTION 'ambiguity failure left a partial ledger or projection';
  END IF;
END
$tie_rollback_proof$;
SQL

# A forced projection table under a NOSUPERUSER/NOBYPASSRLS function owner
# must error at the protected write and roll back its earlier ledger/profile
# writes from the same function statement.
baseline_force="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT public.apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000004',
      'starter',
      10000,
      'sub_force_base',
      600,
      'evt_force_base',
      600,
      true,
      false,
      true
    );
  "
)"
if [[ "$baseline_force" != "applied" ]]; then
  echo "FORCE-RLS baseline was not applied: $baseline_force" >&2
  exit 1
fi

psql_cmd <<'SQL'
ALTER TABLE public.api_keys FORCE ROW LEVEL SECURITY;
ALTER ROLE postgres NOSUPERUSER NOBYPASSRLS;
SQL
expect_failure \
  "SET ROLE service_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000004', 'pro', 0, 'sub_force_new', 700, 'evt_force_should_rollback', 700, true, false, true)" \
  "FORCE RLS did not abort the atomic projection"
psql_cmd <<'SQL'
ALTER ROLE postgres SUPERUSER;
ALTER TABLE public.api_keys NO FORCE ROW LEVEL SECURITY;

DO $force_rls_rollback_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.api_tier_stripe_event_ledger
    WHERE stripe_event_id = 'evt_force_should_rollback'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000004'
      AND api_tier = 'starter'
      AND api_stripe_subscription_id = 'sub_force_base'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000005'
      AND tier = 'starter'
      AND daily_limit = 10000
  ) THEN
    RAISE EXCEPTION 'FORCE-RLS failure committed a partial event projection';
  END IF;
END
$force_rls_rollback_proof$;
SQL

# Migration preflight itself rejects FORCE RLS instead of silently weakening it.
psql_cmd -c \
  "ALTER TABLE public.user_profiles FORCE ROW LEVEL SECURITY" >/dev/null
expect_migration_failure "FORCE RLS projection table was accepted"
psql_cmd -c \
  "ALTER TABLE public.user_profiles NO FORCE ROW LEVEL SECURITY" >/dev/null

# The exact PG17 role graph rejects an unknown inherited service member.
psql_cmd -c \
  "GRANT service_role TO hostile_role WITH INHERIT TRUE, SET FALSE" >/dev/null
expect_migration_failure "hostile inherited service_role authority was accepted"
psql_cmd -c "REVOKE service_role FROM hostile_role" >/dev/null

# A SET chain through the otherwise legitimate authenticator role is equally
# dangerous and must be rejected at both preflight and postflight.
psql_cmd -c \
  "GRANT authenticator TO hostile_role WITH INHERIT FALSE, SET TRUE" >/dev/null
indirect_service_authority="$(
  psql_cmd -Atqc \
    "SELECT pg_catalog.pg_has_role('hostile_role', 'service_role', 'SET')"
)"
if [[ "$indirect_service_authority" != "t" ]]; then
  echo "PG17 did not expose the hostile authenticator → service_role SET chain" >&2
  exit 1
fi
actual_indirect_role="$(
  psql_cmd -Atqc \
    "SET SESSION AUTHORIZATION hostile_role; SET ROLE service_role; SELECT current_user"
)"
if [[ "$actual_indirect_role" != "service_role" ]]; then
  echo "PG17 did not realize the hostile indirect SET ROLE chain" >&2
  exit 1
fi
expect_migration_failure "hostile SET chain through authenticator was accepted"
psql_cmd -c "REVOKE authenticator FROM hostile_role" >/dev/null

# It also rejects a browser SET ROLE path, not merely INHERIT paths.
psql_cmd -c \
  "GRANT service_role TO authenticated WITH INHERIT FALSE, SET TRUE" >/dev/null
expect_migration_failure "authenticated SET ROLE service_role path was accepted"
psql_cmd -c "REVOKE service_role FROM authenticated" >/dev/null

# CREATE IF NOT EXISTS must never accept a lookalike ledger on migration
# replay. Every catalog drift below is restored only after replay fails.
psql_cmd <<'SQL'
ALTER TABLE public.api_tier_stripe_event_ledger
  DROP CONSTRAINT api_tier_stripe_event_ledger_daily_limit_check;
ALTER TABLE public.api_tier_stripe_event_ledger
  ADD CONSTRAINT api_tier_stripe_event_ledger_daily_limit_check
  CHECK (daily_limit >= 0);
SQL
expect_migration_failure "same-name wrong daily-limit CHECK survived replay"
psql_cmd <<'SQL'
ALTER TABLE public.api_tier_stripe_event_ledger
  DROP CONSTRAINT api_tier_stripe_event_ledger_daily_limit_check;
ALTER TABLE public.api_tier_stripe_event_ledger
  ADD CONSTRAINT api_tier_stripe_event_ledger_daily_limit_check
  CHECK (
    (api_tier = 'free' AND daily_limit = 100)
    OR (api_tier = 'starter' AND daily_limit = 10000)
    OR (api_tier = 'pro' AND daily_limit = 0)
  );

ALTER TABLE public.api_tier_stripe_event_ledger
  DROP CONSTRAINT api_tier_stripe_event_ledger_user_fkey;
ALTER TABLE public.api_tier_stripe_event_ledger
  ADD CONSTRAINT api_tier_stripe_event_ledger_user_fkey
  FOREIGN KEY (user_id)
  REFERENCES public.user_profiles(id)
  ON DELETE NO ACTION;
SQL
expect_migration_failure "same-name wrong ledger FK survived replay"
psql_cmd <<'SQL'
ALTER TABLE public.api_tier_stripe_event_ledger
  DROP CONSTRAINT api_tier_stripe_event_ledger_user_fkey;
ALTER TABLE public.api_tier_stripe_event_ledger
  ADD CONSTRAINT api_tier_stripe_event_ledger_user_fkey
  FOREIGN KEY (user_id)
  REFERENCES public.user_profiles(id)
  ON DELETE CASCADE;

ALTER TABLE public.api_tier_stripe_event_ledger
  ALTER COLUMN recorded_at SET DEFAULT pg_catalog.statement_timestamp();
SQL
expect_migration_failure "wrong ledger recorded_at default survived replay"
psql_cmd <<'SQL'
ALTER TABLE public.api_tier_stripe_event_ledger
  ALTER COLUMN recorded_at SET DEFAULT pg_catalog.clock_timestamp();
ALTER TABLE public.api_tier_stripe_event_ledger
  ADD COLUMN injected_payload text;
SQL
expect_migration_failure "extra ledger column survived replay"
psql_cmd <<'SQL'
ALTER TABLE public.api_tier_stripe_event_ledger
  DROP COLUMN injected_payload;

CREATE FUNCTION public.hostile_api_tier_ledger_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.daily_limit := 0;
  RETURN NEW;
END
$function$;
CREATE TRIGGER hostile_api_tier_ledger_insert
BEFORE INSERT ON public.api_tier_stripe_event_ledger
FOR EACH ROW
EXECUTE FUNCTION public.hostile_api_tier_ledger_insert();
SQL
expect_migration_failure "ledger write trigger survived replay"
psql_cmd <<'SQL'
DROP TRIGGER hostile_api_tier_ledger_insert
  ON public.api_tier_stripe_event_ledger;
DROP FUNCTION public.hostile_api_tier_ledger_insert();

DROP INDEX public.api_tier_stripe_event_ledger_user_subscription_idx;
CREATE INDEX api_tier_stripe_event_ledger_user_subscription_idx
  ON public.api_tier_stripe_event_ledger (stripe_event_created);
SQL
expect_migration_failure "same-name wrong ledger index survived replay"
psql_cmd <<'SQL'
DROP INDEX public.api_tier_stripe_event_ledger_user_subscription_idx;
CREATE INDEX api_tier_stripe_event_ledger_user_subscription_idx
  ON public.api_tier_stripe_event_ledger (
    user_id,
    livemode,
    stripe_subscription_id,
    stripe_event_created DESC
  );
SQL

# Replay must converge hostile routine/table/column ACLs while preserving data.
ledger_count_before="$(
  psql_cmd -Atqc \
    "SELECT pg_catalog.count(*) FROM public.api_tier_stripe_event_ledger"
)"
psql_cmd <<'SQL'
GRANT EXECUTE
  ON FUNCTION public.apply_user_api_tier_stripe_event(
    uuid,
    text,
    integer,
    text,
    bigint,
    text,
    bigint,
    boolean,
    boolean,
    boolean
  )
  TO PUBLIC;
GRANT EXECUTE
  ON FUNCTION public.apply_user_api_tier_stripe_event(
    uuid,
    text,
    integer,
    text,
    bigint,
    text,
    bigint,
    boolean,
    boolean,
    boolean
  )
  TO hostile_role WITH GRANT OPTION;
GRANT EXECUTE
  ON FUNCTION public.update_user_api_tier(uuid, text, text, integer)
  TO service_role, hostile_role;
GRANT SELECT
  ON TABLE public.api_tier_stripe_event_ledger
  TO hostile_role WITH GRANT OPTION;
GRANT SELECT (api_tier)
  ON TABLE public.api_tier_stripe_event_ledger
  TO authenticated;
SQL

psql_cmd -f "$MIGRATION"

expect_failure \
  "SET ROLE anon; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'free', 100, 'sub_base', 100, 'evt_acl_denied', 1000, false, true, true)" \
  "PUBLIC EXECUTE survived migration replay"
expect_failure \
  "SET ROLE hostile_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'free', 100, 'sub_base', 100, 'evt_acl_hostile', 1000, false, true, true)" \
  "hostile function grant option survived migration replay"
expect_failure \
  "SET ROLE hostile_role; SELECT * FROM public.api_tier_stripe_event_ledger" \
  "hostile ledger table grant survived migration replay"
expect_failure \
  "SET ROLE authenticated; SELECT api_tier FROM public.api_tier_stripe_event_ledger" \
  "authenticated ledger column grant survived migration replay"
expect_failure \
  "SET ROLE service_role; SELECT public.update_user_api_tier('10000000-0000-4000-8000-000000000001', 'pro', 'sub_acl_forged', 0)" \
  "legacy unsequenced updater grant survived migration replay"

ledger_count_after="$(
  psql_cmd -Atqc \
    "SELECT pg_catalog.count(*) FROM public.api_tier_stripe_event_ledger"
)"
if [[ "$ledger_count_before" != "$ledger_count_after" ]]; then
  echo "Migration replay changed immutable ledger rows" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $final_catalog_proof$
DECLARE
  v_rpc pg_catalog.regprocedure :=
    'public.apply_user_api_tier_stripe_event(uuid,text,integer,text,bigint,text,bigint,boolean,boolean,boolean)'::pg_catalog.regprocedure;
  v_old_rpc pg_catalog.regprocedure :=
    'public.update_user_api_tier(uuid,text,text,integer)'::pg_catalog.regprocedure;
  v_ledger pg_catalog.regclass :=
    'public.api_tier_stripe_event_ledger'::pg_catalog.regclass;
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service oid := pg_catalog.to_regrole('service_role');
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS acl_entry
    WHERE routine.oid = v_rpc
      AND acl_entry.grantee NOT IN (v_postgres, v_service)
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS acl_entry
    WHERE routine.oid = v_old_rpc
      AND acl_entry.grantee <> v_postgres
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = v_ledger
      AND acl_entry.grantee <> v_postgres
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_ledger
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres
  ) THEN
    RAISE EXCEPTION 'final replay ACL seal is incomplete';
  END IF;
END
$final_catalog_proof$;
SQL

echo "API tier Stripe event ledger PG17 proof passed"
