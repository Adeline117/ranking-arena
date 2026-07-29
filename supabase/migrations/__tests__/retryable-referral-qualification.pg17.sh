#!/usr/bin/env bash

# PostgreSQL 17 proof for atomic, retryable referral qualification outcomes.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729060000_retryable_referral_qualification.sql"
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

TMP_ROOT="$(mktemp -d /tmp/retryable-referral-qualification-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
QUALIFY_A_LOG="$TMP_ROOT/qualify-a.log"
QUALIFY_B_LOG="$TMP_ROOT/qualify-b.log"
PORT="$(( 55000 + RANDOM % 5000 ))"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    for diagnostic in "$QUALIFY_A_LOG" "$QUALIFY_B_LOG" "$LOG_FILE"; do
      [[ -f "$diagnostic" ]] && tail -260 "$diagnostic" >&2 || true
    done
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

service_query() {
  local sql="$1"
  psql_cmd -qAtc "
    SET ROLE service_role;
    SET request.jwt.claim.role = 'service_role';
    $sql
    RESET ROLE;
  "
}

expect_value() {
  local label="$1"
  local expected="$2"
  local sql="$3"
  local actual
  actual="$(service_query "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label drifted: expected '$expected', got '$actual'" >&2
    return 1
  fi
}

expect_failure() {
  local label="$1"
  local sql="$2"
  local role="${3:-service_role}"
  local claim="${4:-service_role}"
  local output="$TMP_ROOT/expected-failure.out"
  if psql_cmd -qAtc "
    SET ROLE $role;
    SET request.jwt.claim.role = '$claim';
    $sql
    RESET ROLE;
  " >"$output" 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
}

qualification_call() {
  local attribution_id="$1"
  local friend_days="${2:-7}"
  local device_cap="${3:-3}"
  local threshold="${4:-3}"
  local advocate_days="${5:-30}"
  printf '%s' "public.qualify_referral_attribution_atomic(
    '$attribution_id',
    pg_catalog.date_trunc('milliseconds', pg_catalog.statement_timestamp()),
    24,
    $friend_days,
    $device_cap,
    $threshold,
    $advocate_days
  )"
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
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOINHERIT;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT pg_catalog.current_setting('request.jwt.claim.role', true)
$function$;
ALTER FUNCTION auth.role() OWNER TO postgres;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role, authenticator;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  deleted_at timestamptz,
  onboarding_completed boolean,
  linked_trader_count integer
);
CREATE TABLE public.referral_attributions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  referred_id uuid NOT NULL UNIQUE
    REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  referrer_id uuid NOT NULL
    REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  provider text,
  signup_ip_hash text,
  friend_granted boolean NOT NULL DEFAULT false,
  qualified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.referral_rewards (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  referrer_id uuid NOT NULL
    REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  reward_type text NOT NULL,
  granted_days integer,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (referrer_id, reward_type)
);
CREATE TABLE public.test_entitlement_grants (
  source_key text PRIMARY KEY,
  user_id uuid NOT NULL,
  granted_days integer NOT NULL,
  granted_at timestamptz NOT NULL,
  metadata jsonb NOT NULL
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.referral_attributions OWNER TO postgres;
ALTER TABLE public.referral_rewards OWNER TO postgres;
ALTER TABLE public.test_entitlement_grants OWNER TO postgres;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_entitlement_grants ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.user_profiles,
  public.referral_attributions,
  public.referral_rewards,
  public.test_entitlement_grants
  TO service_role;

CREATE FUNCTION public.grant_pro_entitlement_days_atomic(
  p_user_id uuid,
  p_source text,
  p_source_key text,
  p_days integer,
  p_granted_at timestamptz,
  p_metadata jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_existing public.test_entitlement_grants%ROWTYPE;
BEGIN
  IF p_source IS DISTINCT FROM 'referral' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT grant_row.*
  INTO v_existing
  FROM public.test_entitlement_grants AS grant_row
  WHERE grant_row.source_key = p_source_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id
      OR v_existing.granted_days IS DISTINCT FROM p_days
      OR v_existing.granted_at IS DISTINCT FROM p_granted_at
      OR v_existing.metadata IS DISTINCT FROM p_metadata
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'already_granted');
  END IF;

  INSERT INTO public.test_entitlement_grants (
    source_key,
    user_id,
    granted_days,
    granted_at,
    metadata
  ) VALUES (
    p_source_key,
    p_user_id,
    p_days,
    p_granted_at,
    p_metadata
  );
  RETURN pg_catalog.jsonb_build_object('status', 'granted');
END
$function$;
ALTER FUNCTION public.grant_pro_entitlement_days_atomic(
  uuid, text, text, integer, timestamptz, jsonb
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.grant_pro_entitlement_days_atomic(
  uuid, text, text, integer, timestamptz, jsonb
) FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION public.grant_pro_entitlement_days_atomic(
  uuid, text, text, integer, timestamptz, jsonb
) TO service_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

REFERRER_ONE="10000000-0000-4000-8000-000000000001"
REFERRER_TWO="10000000-0000-4000-8000-000000000002"
REFERRER_THREE="10000000-0000-4000-8000-000000000003"
REFERRED_ONE="20000000-0000-4000-8000-000000000001"
REFERRED_TWO="20000000-0000-4000-8000-000000000002"
REFERRED_THREE="20000000-0000-4000-8000-000000000003"
REFERRED_FOUR="20000000-0000-4000-8000-000000000004"
REFERRED_FIVE="20000000-0000-4000-8000-000000000005"
REFERRED_SIX="20000000-0000-4000-8000-000000000006"
REFERRED_SEVEN="20000000-0000-4000-8000-000000000007"
REFERRED_EIGHT="20000000-0000-4000-8000-000000000008"
REFERRED_NINE="20000000-0000-4000-8000-000000000009"
ATTR_ONE="30000000-0000-4000-8000-000000000001"
ATTR_TWO="30000000-0000-4000-8000-000000000002"
ATTR_THREE="30000000-0000-4000-8000-000000000003"
ATTR_FOUR="30000000-0000-4000-8000-000000000004"
ATTR_FIVE="30000000-0000-4000-8000-000000000005"
ATTR_SIX="30000000-0000-4000-8000-000000000006"
ATTR_SEVEN="30000000-0000-4000-8000-000000000007"
ATTR_EIGHT="30000000-0000-4000-8000-000000000008"
ATTR_NINE="30000000-0000-4000-8000-000000000009"
MISSING="90000000-0000-4000-8000-000000000001"
HASH_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
HASH_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
HASH_C="cccccccccccccccccccccccccccccccc"

psql_cmd <<SQL
INSERT INTO public.user_profiles (
  id,
  created_at,
  onboarding_completed,
  linked_trader_count
) VALUES
  ('$REFERRER_ONE', pg_catalog.clock_timestamp() - interval '30 days', true, 1),
  ('$REFERRER_TWO', pg_catalog.clock_timestamp() - interval '30 days', true, 1),
  ('$REFERRER_THREE', pg_catalog.clock_timestamp() - interval '30 days', true, 1),
  ('$REFERRED_ONE', pg_catalog.clock_timestamp() - interval '2 days', true, 0),
  ('$REFERRED_TWO', pg_catalog.clock_timestamp() - interval '2 days', true, 0),
  ('$REFERRED_THREE', pg_catalog.clock_timestamp() - interval '2 days', true, 0),
  ('$REFERRED_FOUR', pg_catalog.clock_timestamp() - interval '2 days', true, 0),
  ('$REFERRED_FIVE', pg_catalog.clock_timestamp() - interval '2 days', true, 0),
  ('$REFERRED_SIX', pg_catalog.clock_timestamp() - interval '2 days', true, 0),
  ('$REFERRED_SEVEN', pg_catalog.clock_timestamp() - interval '2 days', true, 0),
  ('$REFERRED_EIGHT', pg_catalog.clock_timestamp() - interval '2 days', true, 0),
  ('$REFERRED_NINE', pg_catalog.clock_timestamp(), false, 0);

INSERT INTO public.referral_attributions (
  id,
  referred_id,
  referrer_id,
  signup_ip_hash,
  created_at
) VALUES
  ('$ATTR_ONE', '$REFERRED_ONE', '$REFERRER_ONE', '$HASH_A',
    pg_catalog.clock_timestamp() - interval '9 hours'),
  ('$ATTR_TWO', '$REFERRED_TWO', '$REFERRER_ONE', '$HASH_B',
    pg_catalog.clock_timestamp() - interval '8 hours'),
  ('$ATTR_THREE', '$REFERRED_THREE', '$REFERRER_ONE', '$HASH_A',
    pg_catalog.clock_timestamp() - interval '7 hours'),
  ('$ATTR_FOUR', '$REFERRED_FOUR', '$REFERRER_ONE', '$HASH_C',
    pg_catalog.clock_timestamp() - interval '6 hours'),
  ('$ATTR_FIVE', '$REFERRED_FIVE', '$REFERRER_TWO', NULL,
    pg_catalog.clock_timestamp() - interval '5 hours'),
  ('$ATTR_SIX', '$REFERRED_SIX', '$REFERRER_THREE', '11111111111111111111111111111111',
    pg_catalog.clock_timestamp() - interval '4 hours'),
  ('$ATTR_SEVEN', '$REFERRED_SEVEN', '$REFERRER_THREE', '22222222222222222222222222222222',
    pg_catalog.clock_timestamp() - interval '3 hours'),
  ('$ATTR_EIGHT', '$REFERRED_EIGHT', '$REFERRER_THREE', '33333333333333333333333333333333',
    pg_catalog.clock_timestamp() - interval '2 hours'),
  ('$ATTR_NINE', '$REFERRED_NINE', '$REFERRER_TWO', NULL,
    pg_catalog.clock_timestamp() - interval '1 hour');
SQL

expect_value \
  "authenticated candidate claim execution is closed" \
  "f" \
  "SELECT pg_catalog.has_function_privilege(
    'authenticated',
    'public.claim_referral_qualification_candidates_atomic(timestamp with time zone,integer)',
    'EXECUTE'
  );"
expect_value \
  "authenticated qualification execution is closed" \
  "f" \
  "SELECT pg_catalog.has_function_privilege(
    'authenticated',
    'public.qualify_referral_attribution_atomic(uuid,timestamp with time zone,integer,integer,integer,integer,integer)',
    'EXECUTE'
  );"
expect_value \
  "service qualification execution remains available" \
  "t" \
  "SELECT pg_catalog.has_function_privilege(
    'service_role',
    'public.qualify_referral_attribution_atomic(uuid,timestamp with time zone,integer,integer,integer,integer,integer)',
    'EXECUTE'
  );"
expect_failure \
  "authenticated caller cannot settle referral benefits" \
  "SELECT $(qualification_call "$ATTR_ONE");" \
  authenticated \
  authenticated

expect_value \
  "invalid candidate claim fails closed with null instead of fabricated emptiness" \
  "t" \
  "SELECT public.claim_referral_qualification_candidates_atomic(
    pg_catalog.date_trunc('milliseconds', pg_catalog.statement_timestamp()),
    0
  ) IS NULL;"
expect_value \
  "oldest never-checked candidate is claimed first" \
  "[{\"id\": \"$ATTR_ONE\"}]" \
  "SELECT public.claim_referral_qualification_candidates_atomic(
    pg_catalog.date_trunc('milliseconds', pg_catalog.statement_timestamp()),
    1
  )::text;"
expect_value \
  "candidate claim persists its fairness watermark" \
  "1" \
  "SELECT pg_catalog.count(*)::text
   FROM public.referral_attributions
   WHERE id = '$ATTR_ONE'
     AND qualification_checked_at IS NOT NULL;"
expect_value \
  "next claim rotates past the already-checked pending row" \
  "[{\"id\": \"$ATTR_TWO\"}]" \
  "SELECT public.claim_referral_qualification_candidates_atomic(
    pg_catalog.date_trunc('milliseconds', pg_catalog.statement_timestamp()),
    1
  )::text;"

expect_value \
  "missing attribution is a zero-row not-found result" \
  "not_found" \
  "SELECT $(qualification_call "$MISSING") ->> 'status';"
expect_value \
  "invalid policy fails closed before mutation" \
  "invalid" \
  "SELECT $(qualification_call "$ATTR_ONE" 7 0) ->> 'status';"
expect_value \
  "ineligible account stays explicitly pending" \
  "not_eligible|0|pending|0" \
  "SELECT
    (result ->> 'status') || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.referral_attributions
      WHERE id = '$ATTR_NINE'
        AND qualified_at IS NOT NULL
    ) || '|' ||
    (
      SELECT friend_grant_status
      FROM public.referral_attributions
      WHERE id = '$ATTR_NINE'
    ) || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.test_entitlement_grants
      WHERE source_key = 'friend:$ATTR_NINE'
    )
  FROM (
    SELECT $(qualification_call "$ATTR_NINE") AS result
  ) AS ineligible;"

expect_value \
  "first qualification settles its friend grant" \
  "qualified|granted|pending" \
  "SELECT
    (result ->> 'status') || '|' ||
    (result ->> 'friend_status') || '|' ||
    (result ->> 'advocate_status')
  FROM (
    SELECT $(qualification_call "$ATTR_ONE") AS result
  ) AS qualified;"
expect_value \
  "first qualification commits every owned state together" \
  "1|granted|1|1|0" \
  "SELECT
    pg_catalog.count(*) FILTER (
      WHERE attribution.qualified_at IS NOT NULL
    )::text || '|' ||
    attribution.friend_grant_status || '|' ||
    pg_catalog.count(*) FILTER (
      WHERE attribution.friend_granted
    )::text || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.test_entitlement_grants
      WHERE source_key = 'friend:$ATTR_ONE'
    ) || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.referral_rewards
      WHERE referrer_id = '$REFERRER_ONE'
    )
  FROM public.referral_attributions AS attribution
  WHERE attribution.id = '$ATTR_ONE'
  GROUP BY attribution.friend_grant_status;"
expect_value \
  "exact qualification retry is financially idempotent" \
  "already_qualified|already_granted|1" \
  "SELECT
    (result ->> 'status') || '|' ||
    (result ->> 'friend_status') || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.test_entitlement_grants
      WHERE source_key = 'friend:$ATTR_ONE'
    )
  FROM (
    SELECT $(qualification_call "$ATTR_ONE") AS result
  ) AS retried;"

# Concurrent retries for one fresh attribution serialize through one authority.
(
  service_query "
    SELECT
      (result ->> 'status') || '|' ||
      (result ->> 'friend_status')
    FROM (
      SELECT $(qualification_call "$ATTR_TWO") AS result
    ) AS qualified;
  "
) >"$QUALIFY_A_LOG" 2>&1 &
QUALIFY_A_PID=$!
(
  service_query "
    SELECT
      (result ->> 'status') || '|' ||
      (result ->> 'friend_status')
    FROM (
      SELECT $(qualification_call "$ATTR_TWO") AS result
    ) AS qualified;
  "
) >"$QUALIFY_B_LOG" 2>&1 &
QUALIFY_B_PID=$!
wait "$QUALIFY_A_PID"
wait "$QUALIFY_B_PID"

CONCURRENT_RESULTS="$(
  { cat "$QUALIFY_A_LOG"; cat "$QUALIFY_B_LOG"; } |
    sed '/^[[:space:]]*$/d' |
    sort |
    paste -sd, -
)"
if [[ "$CONCURRENT_RESULTS" != \
"already_qualified|already_granted,qualified|granted" ]]; then
  echo "concurrent qualification did not serialize: $CONCURRENT_RESULTS" >&2
  exit 1
fi
expect_value \
  "concurrent qualification created one friend entitlement" \
  "1|granted|1" \
  "SELECT
    pg_catalog.count(*) FILTER (
      WHERE attribution.qualified_at IS NOT NULL
    )::text || '|' ||
    attribution.friend_grant_status || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.test_entitlement_grants
      WHERE source_key = 'friend:$ATTR_TWO'
    )
  FROM public.referral_attributions AS attribution
  WHERE attribution.id = '$ATTR_TWO'
  GROUP BY attribution.friend_grant_status;"

expect_value \
  "device cap records a terminal capped outcome" \
  "qualified|capped" \
  "SELECT
    (result ->> 'status') || '|' ||
    (result ->> 'friend_status')
  FROM (
    SELECT $(qualification_call "$ATTR_THREE" 7 1) AS result
  ) AS capped;"
expect_value \
  "capped outcome creates no financial authority" \
  "capped|0|0" \
  "SELECT
    attribution.friend_grant_status || '|' ||
    CASE WHEN attribution.friend_granted THEN '1' ELSE '0' END || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.test_entitlement_grants
      WHERE source_key = 'friend:$ATTR_THREE'
    )
  FROM public.referral_attributions AS attribution
  WHERE attribution.id = '$ATTR_THREE';"

psql_cmd <<SQL
CREATE FUNCTION public.reject_advocate_reward_settlement_for_test()
RETURNS trigger
LANGUAGE plpgsql
AS \$function\$
BEGIN
  IF NEW.entitlement_granted_at IS NOT NULL THEN
    RAISE EXCEPTION 'injected advocate settlement failure';
  END IF;
  RETURN NEW;
END
\$function\$;
CREATE TRIGGER reject_advocate_reward_settlement_for_test
BEFORE UPDATE ON public.referral_rewards
FOR EACH ROW EXECUTE FUNCTION public.reject_advocate_reward_settlement_for_test();
SQL

expect_failure \
  "injected advocate grant failure rolls back qualification and friend grant" \
  "SELECT $(qualification_call "$ATTR_FOUR");"
expect_value \
  "failed advocate settlement restored every pending outcome" \
  "0|pending|0|0|0" \
  "SELECT
    CASE WHEN attribution.qualified_at IS NULL THEN '0' ELSE '1' END || '|' ||
    attribution.friend_grant_status || '|' ||
    CASE WHEN attribution.friend_granted THEN '1' ELSE '0' END || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.test_entitlement_grants
      WHERE source_key IN (
        'friend:$ATTR_FOUR',
        (
          SELECT 'advocate:' || reward.id::text
          FROM public.referral_rewards AS reward
          WHERE reward.referrer_id = '$REFERRER_ONE'
        )
      )
    ) || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.referral_rewards
      WHERE referrer_id = '$REFERRER_ONE'
    )
  FROM public.referral_attributions AS attribution
  WHERE attribution.id = '$ATTR_FOUR';"

psql_cmd -qc "
  DROP TRIGGER reject_advocate_reward_settlement_for_test
    ON public.referral_rewards;
  DROP FUNCTION public.reject_advocate_reward_settlement_for_test();
"

expect_value \
  "retry settles qualification and both entitlements" \
  "qualified|granted|granted" \
  "SELECT
    (result ->> 'status') || '|' ||
    (result ->> 'friend_status') || '|' ||
    (result ->> 'advocate_status')
  FROM (
    SELECT $(qualification_call "$ATTR_FOUR") AS result
  ) AS settled;"
expect_value \
  "successful retry commits one advocate marker and authority" \
  "1|1|1|1" \
  "SELECT
    pg_catalog.count(*)::text || '|' ||
    pg_catalog.count(*) FILTER (
      WHERE reward.entitlement_granted_at IS NOT NULL
    )::text || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.test_entitlement_grants
      WHERE source_key = 'friend:$ATTR_FOUR'
    ) || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.test_entitlement_grants AS grant_row
      WHERE grant_row.source_key = 'advocate:' || reward.id::text
    )
  FROM public.referral_rewards AS reward
  WHERE reward.referrer_id = '$REFERRER_ONE'
  GROUP BY reward.id;"

# Historical flag-first state: the boolean was committed but no entitlement.
psql_cmd -qc "
  UPDATE public.referral_attributions
  SET qualified_at = pg_catalog.clock_timestamp() - interval '1 hour',
      friend_granted = true,
      friend_grant_status = 'pending'
  WHERE id = '$ATTR_FIVE';
"
expect_value \
  "flag-first historical state repairs its missing friend grant" \
  "already_qualified|granted" \
  "SELECT
    (result ->> 'status') || '|' ||
    (result ->> 'friend_status')
  FROM (
    SELECT $(qualification_call "$ATTR_FIVE" 7 3 99) AS result
  ) AS repaired;"
expect_value \
  "flag-first repair commits the missing friend authority" \
  "1|granted" \
  "SELECT
    (
      SELECT pg_catalog.count(*)::text
      FROM public.test_entitlement_grants
      WHERE source_key = 'friend:$ATTR_FIVE'
    ) || '|' ||
    attribution.friend_grant_status
  FROM public.referral_attributions AS attribution
  WHERE attribution.id = '$ATTR_FIVE';"

# Historical marker-first state: threshold marker exists but Pro grant did not.
psql_cmd <<SQL
UPDATE public.referral_attributions
SET qualified_at = pg_catalog.clock_timestamp() - interval '1 hour',
    friend_granted = false,
    friend_grant_status = 'disabled'
WHERE id IN ('$ATTR_SIX', '$ATTR_SEVEN', '$ATTR_EIGHT');

INSERT INTO public.referral_rewards (
  id,
  referrer_id,
  reward_type,
  granted_days,
  created_at
) VALUES (
  '40000000-0000-4000-8000-000000000001',
  '$REFERRER_THREE',
  'advocate_milestone',
  30,
  pg_catalog.clock_timestamp() - interval '30 minutes'
);
SQL

expect_value \
  "marker-first historical state repairs its missing advocate grant" \
  "already_qualified|disabled|granted" \
  "SELECT
    (result ->> 'status') || '|' ||
    (result ->> 'friend_status') || '|' ||
    (result ->> 'advocate_status')
  FROM (
    SELECT $(qualification_call "$ATTR_EIGHT" 0 3 3) AS result
  ) AS repaired;"
expect_value \
  "marker-first repair records exact entitlement completion" \
  "1|1" \
  "SELECT
    pg_catalog.count(*) FILTER (
      WHERE reward.entitlement_granted_at IS NOT NULL
    )::text || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.test_entitlement_grants
      WHERE source_key = 'advocate:' || reward.id::text
    )
  FROM public.referral_rewards AS reward
  WHERE reward.id = '40000000-0000-4000-8000-000000000001'
  GROUP BY reward.id;"

echo "retryable referral qualification PostgreSQL 17 proof passed"
