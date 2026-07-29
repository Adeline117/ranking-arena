#!/usr/bin/env bash

# PostgreSQL 17 proof for rollback-safe, race-safe referral attribution.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729059000_atomic_referral_attribution.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-referral-attribution-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
APPLY_A_LOG="$TMP_ROOT/apply-a.log"
APPLY_B_LOG="$TMP_ROOT/apply-b.log"
PORT="$(( 55000 + RANDOM % 5000 ))"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    for diagnostic in "$APPLY_A_LOG" "$APPLY_B_LOG" "$LOG_FILE"; do
      [[ -f "$diagnostic" ]] && tail -240 "$diagnostic" >&2 || true
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
  referred_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  deleted_at timestamptz
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

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.referral_attributions OWNER TO postgres;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_attributions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.user_profiles,
  public.referral_attributions
  TO service_role;

INSERT INTO public.user_profiles (id) VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000003'),
  ('20000000-0000-4000-8000-000000000004'),
  ('20000000-0000-4000-8000-000000000005');
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

REFERRER_ONE="10000000-0000-4000-8000-000000000001"
REFERRER_TWO="10000000-0000-4000-8000-000000000002"
REFERRED_ONE="20000000-0000-4000-8000-000000000001"
REFERRED_TWO="20000000-0000-4000-8000-000000000002"
REFERRED_THREE="20000000-0000-4000-8000-000000000003"
REFERRED_FOUR="20000000-0000-4000-8000-000000000004"
REFERRED_FIVE="20000000-0000-4000-8000-000000000005"
MISSING="90000000-0000-4000-8000-000000000001"
HASH="0123456789abcdef0123456789abcdef"

expect_value \
  "authenticated RPC execution is closed" \
  "f" \
  "SELECT pg_catalog.has_function_privilege(
    'authenticated',
    'public.apply_referral_attribution_atomic(uuid,uuid,text,text)',
    'EXECUTE'
  );"
expect_value \
  "service RPC execution remains available" \
  "t" \
  "SELECT pg_catalog.has_function_privilege(
    'service_role',
    'public.apply_referral_attribution_atomic(uuid,uuid,text,text)',
    'EXECUTE'
  );"
expect_failure \
  "authenticated caller cannot write referral authority" \
  "SELECT public.apply_referral_attribution_atomic(
    '$REFERRED_ONE',
    '$REFERRER_ONE',
    'google',
    '$HASH'
  );" \
  authenticated \
  authenticated

expect_value \
  "missing referred row is a zero-row not-found result" \
  "not_found" \
  "SELECT public.apply_referral_attribution_atomic(
    '$MISSING',
    '$REFERRER_ONE',
    'google',
    '$HASH'
  ) ->> 'status';"
expect_value \
  "self-referral fails closed before mutation" \
  "invalid" \
  "SELECT public.apply_referral_attribution_atomic(
    '$REFERRER_ONE',
    '$REFERRER_ONE',
    'google',
    '$HASH'
  ) ->> 'status';"
expect_value \
  "malformed device hash fails closed before mutation" \
  "invalid" \
  "SELECT public.apply_referral_attribution_atomic(
    '$REFERRED_ONE',
    '$REFERRER_ONE',
    'google',
    'not-a-hash'
  ) ->> 'status';"

psql_cmd <<SQL
CREATE FUNCTION public.reject_referral_profile_update_for_test()
RETURNS trigger
LANGUAGE plpgsql
AS \$function\$
BEGIN
  IF NEW.id = '$REFERRED_ONE'::uuid AND NEW.referred_by IS NOT NULL THEN
    RAISE EXCEPTION 'injected profile edge failure';
  END IF;
  RETURN NEW;
END
\$function\$;
CREATE TRIGGER reject_referral_profile_update_for_test
BEFORE UPDATE ON public.user_profiles
FOR EACH ROW EXECUTE FUNCTION public.reject_referral_profile_update_for_test();
SQL

expect_failure \
  "profile edge failure rolls back the inserted attribution" \
  "SELECT public.apply_referral_attribution_atomic(
    '$REFERRED_ONE',
    '$REFERRER_ONE',
    'google',
    '$HASH'
  );"
expect_value \
  "failed attribution left neither half-write behind" \
  "0|0" \
  "SELECT
    pg_catalog.count(*) FILTER (
      WHERE profile.referred_by IS NOT NULL
    )::text || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.referral_attributions AS attribution
      WHERE attribution.referred_id = '$REFERRED_ONE'
    )
  FROM public.user_profiles AS profile
  WHERE profile.id = '$REFERRED_ONE';"

psql_cmd -qc "
  DROP TRIGGER reject_referral_profile_update_for_test
    ON public.user_profiles;
  DROP FUNCTION public.reject_referral_profile_update_for_test();
"

expect_value \
  "retry atomically creates both referral records" \
  "applied|true" \
  "SELECT
    (result ->> 'status') || '|' ||
    (result ->> 'created')
  FROM (
    SELECT public.apply_referral_attribution_atomic(
      '$REFERRED_ONE',
      '$REFERRER_ONE',
      'google',
      '$HASH'
    ) AS result
  ) AS applied;"
expect_value \
  "successful retry committed both referral records" \
  "1|1" \
  "SELECT
    pg_catalog.count(*) FILTER (
      WHERE profile.referred_by = '$REFERRER_ONE'
    )::text || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.referral_attributions AS attribution
      WHERE attribution.referred_id = '$REFERRED_ONE'
        AND attribution.referrer_id = '$REFERRER_ONE'
    )
  FROM public.user_profiles AS profile
  WHERE profile.id = '$REFERRED_ONE';"
expect_value \
  "exact retry is idempotent" \
  "already_applied|false" \
  "SELECT
    (result ->> 'status') || '|' ||
    (result ->> 'created')
  FROM (
    SELECT public.apply_referral_attribution_atomic(
      '$REFERRED_ONE',
      '$REFERRER_ONE',
      'github',
      NULL
    ) AS result
  ) AS retried;"
expect_value \
  "exact retry did not duplicate attribution" \
  "1" \
  "SELECT pg_catalog.count(*)::text
   FROM public.referral_attributions AS attribution
   WHERE attribution.referred_id = '$REFERRED_ONE';"
expect_value \
  "a different code cannot replace immutable attribution" \
  "conflict|$REFERRER_ONE|$REFERRER_ONE" \
  "SELECT
    (result ->> 'status') || '|' ||
    (
      SELECT profile.referred_by::text
      FROM public.user_profiles AS profile
      WHERE profile.id = '$REFERRED_ONE'
    ) || '|' ||
    (
      SELECT attribution.referrer_id::text
      FROM public.referral_attributions AS attribution
      WHERE attribution.referred_id = '$REFERRED_ONE'
    )
  FROM (
    SELECT public.apply_referral_attribution_atomic(
      '$REFERRED_ONE',
      '$REFERRER_TWO',
      'google',
      '$HASH'
    ) AS result
  ) AS conflicted;"

# Repair the historical profile-only half-write.
psql_cmd -qc "
  UPDATE public.user_profiles
  SET referred_by = '$REFERRER_ONE'
  WHERE id = '$REFERRED_TWO';
"
expect_value \
  "profile-only historical state gains its missing attribution" \
  "applied|true" \
  "SELECT
    (result ->> 'status') || '|' ||
    (result ->> 'created')
  FROM (
    SELECT public.apply_referral_attribution_atomic(
      '$REFERRED_TWO',
      '$REFERRER_ONE',
      NULL,
      NULL
    ) AS result
  ) AS repaired;"
expect_value \
  "profile-only repair committed its missing attribution" \
  "1" \
  "SELECT pg_catalog.count(*)::text
   FROM public.referral_attributions
   WHERE referred_id = '$REFERRED_TWO'
     AND referrer_id = '$REFERRER_ONE';"

# Repair the inverse attribution-only half-write.
psql_cmd -qc "
  INSERT INTO public.referral_attributions (
    referred_id,
    referrer_id,
    provider,
    friend_granted
  ) VALUES (
    '$REFERRED_THREE',
    '$REFERRER_ONE',
    'legacy',
    false
  );
"
expect_value \
  "attribution-only historical state gains its missing profile edge" \
  "already_applied|false" \
  "SELECT
    (result ->> 'status') || '|' ||
    (result ->> 'created')
  FROM (
    SELECT public.apply_referral_attribution_atomic(
      '$REFERRED_THREE',
      '$REFERRER_ONE',
      'google',
      '$HASH'
    ) AS result
  ) AS repaired;"
expect_value \
  "attribution-only repair committed its missing profile edge" \
  "$REFERRER_ONE" \
  "SELECT profile.referred_by::text
   FROM public.user_profiles AS profile
   WHERE profile.id = '$REFERRED_THREE';"

# Two different codes racing for one user serialize on the profile identity.
(
  service_query "
    SELECT public.apply_referral_attribution_atomic(
      '$REFERRED_FOUR',
      '$REFERRER_ONE',
      'google',
      '$HASH'
    ) ->> 'status';
  "
) >"$APPLY_A_LOG" 2>&1 &
APPLY_A_PID=$!
(
  service_query "
    SELECT public.apply_referral_attribution_atomic(
      '$REFERRED_FOUR',
      '$REFERRER_TWO',
      'google',
      '$HASH'
    ) ->> 'status';
  "
) >"$APPLY_B_LOG" 2>&1 &
APPLY_B_PID=$!
wait "$APPLY_A_PID"
wait "$APPLY_B_PID"

CONCURRENT_STATUSES="$(
  { cat "$APPLY_A_LOG"; cat "$APPLY_B_LOG"; } |
    sed '/^[[:space:]]*$/d' |
    sort |
    paste -sd, -
)"
if [[ "$CONCURRENT_STATUSES" != "applied,conflict" ]]; then
  echo "concurrent referral requests were not serialized: $CONCURRENT_STATUSES" >&2
  exit 1
fi
expect_value \
  "concurrent attribution leaves one internally consistent identity" \
  "1|1|1" \
  "SELECT
    pg_catalog.count(*)::text || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.referral_attributions
      WHERE referred_id = '$REFERRED_FOUR'
    ) || '|' ||
    pg_catalog.count(*) FILTER (
      WHERE profile.referred_by = attribution.referrer_id
    )::text
  FROM public.user_profiles AS profile
  JOIN public.referral_attributions AS attribution
    ON attribution.referred_id = profile.id
  WHERE profile.id = '$REFERRED_FOUR';"

# A deleted referrer is not eligible and cannot consume the referred user.
psql_cmd -qc "
  UPDATE public.user_profiles
  SET deleted_at = pg_catalog.clock_timestamp()
  WHERE id = '$REFERRER_TWO';
"
expect_value \
  "deleted referrer is rejected without a half-write" \
  "not_found|0|0" \
  "SELECT
    (result ->> 'status') || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.user_profiles
      WHERE id = '$REFERRED_FIVE'
        AND referred_by IS NOT NULL
    ) || '|' ||
    (
      SELECT pg_catalog.count(*)::text
      FROM public.referral_attributions
      WHERE referred_id = '$REFERRED_FIVE'
    )
  FROM (
    SELECT public.apply_referral_attribution_atomic(
      '$REFERRED_FIVE',
      '$REFERRER_TWO',
      'google',
      '$HASH'
    ) AS result
  ) AS rejected;"

echo "atomic referral attribution PostgreSQL 17 proof passed"
