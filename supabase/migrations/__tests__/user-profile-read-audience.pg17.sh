#!/usr/bin/env bash

# PostgreSQL 17 proof for active-or-self user_profiles row visibility.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716179100_user_profile_read_audience.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/user-profile-read-audience-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55580
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_migration_failure() {
  local needle="$1"
  local label="$2"
  local failure_log="$TMP_ROOT/${label}.log"
  if psql_cmd -f "$MIGRATION" >"$failure_log" 2>&1; then
    echo "Expected migration failure: $label" >&2
    return 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    cat "$failure_log" >&2
    echo "Missing migration failure evidence: $needle" >&2
    return 1
  fi
}

assert_query() {
  local expected="$1"
  local sql="$2"
  local label="$3"
  local actual
  actual="$(psql_cmd -Atqc "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label: expected '$expected', got '$actual'" >&2
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
CREATE ROLE hostile_owner NOLOGIN;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.sub', true),
    ''
  )::uuid
$function$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  handle text NOT NULL UNIQUE,
  email text,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean,
  ban_expires_at timestamptz,
  bio text
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.user_profiles TO anon, authenticated, service_role;
GRANT UPDATE (handle, bio) ON public.user_profiles TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.user_profiles TO service_role;

INSERT INTO public.user_profiles (
  id,
  handle,
  email,
  deleted_at,
  banned_at,
  is_banned,
  ban_expires_at
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'active', 'active@example.com', NULL, NULL, false, NULL),
  ('22222222-2222-4222-8222-222222222222', 'deleted', 'deleted@example.com', pg_catalog.clock_timestamp(), NULL, false, NULL),
  ('33333333-3333-4333-8333-333333333333', 'banned_at', 'banned-at@example.com', NULL, pg_catalog.clock_timestamp(), false, NULL),
  ('44444444-4444-4444-8444-444444444444', 'permanent', 'permanent@example.com', NULL, NULL, true, NULL),
  ('55555555-5555-4555-8555-555555555555', 'temporary', 'temporary@example.com', NULL, NULL, true, pg_catalog.clock_timestamp() + interval '1 day'),
  ('66666666-6666-4666-8666-666666666666', 'expired', 'expired@example.com', NULL, NULL, true, pg_catalog.clock_timestamp() - interval '1 day'),
  ('77777777-7777-4777-8777-777777777777', 'other', 'other@example.com', NULL, NULL, NULL, NULL);

CREATE POLICY "User profiles are viewable by everyone"
  ON public.user_profiles FOR SELECT TO public USING (true);
CREATE POLICY manual_profile_read_backdoor
  ON public.user_profiles FOR SELECT TO anon USING (true);
CREATE POLICY user_profiles_authenticated_safe_update
  ON public.user_profiles FOR UPDATE TO authenticated
  USING (
    id = (SELECT auth.uid())
    AND deleted_at IS NULL
    AND banned_at IS NULL
    AND NOT (
      COALESCE(is_banned, false)
      AND (
        ban_expires_at IS NULL
        OR ban_expires_at > pg_catalog.statement_timestamp()
      )
    )
  )
  WITH CHECK (
    id = (SELECT auth.uid())
    AND deleted_at IS NULL
    AND banned_at IS NULL
    AND NOT (
      COALESCE(is_banned, false)
      AND (
        ban_expires_at IS NULL
        OR ban_expires_at > pg_catalog.statement_timestamp()
      )
    )
  );
CREATE POLICY user_profiles_service_mutation
  ON public.user_profiles FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE FUNCTION public.get_own_profile_sensitive()
RETURNS TABLE(email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT profile.email
  FROM public.user_profiles AS profile
  WHERE profile.id = auth.uid()
$function$;
ALTER FUNCTION public.get_own_profile_sensitive() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_own_profile_sensitive() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_own_profile_sensitive() TO authenticated;
SQL

# Reproduce the row-enumeration bug before hardening.
assert_query \
  '7' \
  'SET ROLE anon; SELECT pg_catalog.count(*) FROM public.user_profiles' \
  'vulnerable anon fixture'

# Preflight failures are atomic and leave the vulnerable policy set untouched.
psql_cmd -c 'ALTER TABLE public.user_profiles OWNER TO hostile_owner' >/dev/null
expect_migration_failure \
  'public.user_profiles must be an ordinary postgres-owned table' \
  'owner-drift'
assert_query \
  '7' \
  'SET ROLE anon; SELECT pg_catalog.count(*) FROM public.user_profiles' \
  'owner preflight rollback'
psql_cmd <<'SQL'
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.user_profiles RENAME COLUMN is_banned TO is_banned_drift;
SQL
expect_migration_failure \
  'public.user_profiles read-audience columns are incompatible' \
  'column-drift'
psql_cmd -c \
  'ALTER TABLE public.user_profiles RENAME COLUMN is_banned_drift TO is_banned' \
  >/dev/null

psql_cmd -f "$MIGRATION" >/dev/null

# Anonymous callers see only active rows.  An anon role cannot activate the
# self exception even if a session sub is present.
assert_query \
  'active,expired,other' \
  "SET ROLE anon; SELECT pg_catalog.string_agg(handle, ',' ORDER BY handle) FROM public.user_profiles" \
  'anonymous active audience'
assert_query \
  '0' \
  "SET ROLE anon; SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222'; SELECT pg_catalog.count(*) FROM public.user_profiles WHERE id = '22222222-2222-4222-8222-222222222222'" \
  'anonymous forged self audience'

# An authenticated current account can still read itself when deleted/banned,
# but cannot enumerate any other inactive account.
assert_query \
  '4' \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222'; SELECT pg_catalog.count(*) FROM public.user_profiles" \
  'deleted self visibility'
assert_query \
  'deleted' \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222'; SELECT handle FROM public.user_profiles WHERE id = '22222222-2222-4222-8222-222222222222'" \
  'deleted self direct read'
assert_query \
  '0' \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222'; SELECT pg_catalog.count(*) FROM public.user_profiles WHERE id = '33333333-3333-4333-8333-333333333333'" \
  'other banned row hidden'
assert_query \
  '4' \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444'; SELECT pg_catalog.count(*) FROM public.user_profiles" \
  'permanent banned self visibility'
assert_query \
  '' \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222'; UPDATE public.user_profiles SET bio = 'must-stay-frozen' WHERE id = '22222222-2222-4222-8222-222222222222' RETURNING id" \
  'deleted self remains mutation-frozen'
assert_query \
  '11111111-1111-4111-8111-111111111111' \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; UPDATE public.user_profiles SET bio = 'active-self-write' WHERE id = '11111111-1111-4111-8111-111111111111' RETURNING id" \
  'active self mutation compatibility'

# The existing own-sensitive-profile helper remains usable for a deleted
# current account; it is owner-defined and still binds the result to auth.uid.
assert_query \
  'deleted@example.com' \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222'; SELECT email FROM public.get_own_profile_sensitive()" \
  'own sensitive helper compatibility'

# service_role is deliberately NOBYPASSRLS in this fixture.  Full visibility
# and mutation therefore prove the recreated service policy is authoritative.
assert_query \
  '7' \
  'SET ROLE service_role; SELECT pg_catalog.count(*) FROM public.user_profiles' \
  'service full audience'
psql_cmd -Atqc \
  "SET ROLE service_role; UPDATE public.user_profiles SET bio = 'recovery-visible' WHERE id = '22222222-2222-4222-8222-222222222222'" \
  >/dev/null

# ACCESS EXCLUSIVE replay serializes against an in-flight browser read, then
# converges without changing the final audience.
psql_cmd >"$TMP_ROOT/read-holder.log" 2>&1 <<'SQL' &
BEGIN;
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SELECT pg_catalog.count(*) FROM public.user_profiles;
SELECT pg_catalog.pg_sleep(1.25) /* profile-read-audience-holder */;
COMMIT;
SQL
HOLDER_PID=$!
for _ in {1..60}; do
  if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE query LIKE '%profile-read-audience-holder%' AND state = 'active'")" == "1" ]]; then
    break
  fi
  sleep 0.05
done
psql_cmd -f "$MIGRATION" >/dev/null
if ! wait "$HOLDER_PID"; then
  cat "$TMP_ROOT/read-holder.log" >&2
  exit 1
fi

# Unknown SELECT and FOR ALL policies are permissive OR backdoors.  Replay must
# remove both, while leaving the canonical authenticated UPDATE policy intact.
psql_cmd <<'SQL'
CREATE POLICY replay_profile_read_backdoor
  ON public.user_profiles FOR SELECT TO public USING (true);
CREATE POLICY replay_profile_all_backdoor
  ON public.user_profiles FOR ALL TO anon
  USING (true) WITH CHECK (true);
SQL
assert_query \
  '7' \
  'SET ROLE anon; SELECT pg_catalog.count(*) FROM public.user_profiles' \
  'replay drift fixture'

psql_cmd -f "$MIGRATION" >/dev/null
assert_query \
  '3' \
  'SET ROLE anon; SELECT pg_catalog.count(*) FROM public.user_profiles' \
  'replay active audience'

psql_cmd <<'SQL'
DO $catalog_proof$
DECLARE
  v_anon oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'anon'
  );
  v_authenticated oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'
  );
  v_service oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polcmd IN ('r', '*')
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polname = 'user_profiles_active_or_self_read'
      AND policy.polcmd = 'r'
      AND policy.polroles @> ARRAY[v_anon, v_authenticated]::oid[]
      AND policy.polroles <@ ARRAY[v_anon, v_authenticated]::oid[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polname = 'user_profiles_service_mutation'
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service]::oid[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polname = 'user_profiles_authenticated_safe_update'
      AND policy.polcmd = 'w'
      AND policy.polroles = ARRAY[v_authenticated]::oid[]
  ) THEN
    RAISE EXCEPTION 'profile read policy catalog proof failed';
  END IF;
END
$catalog_proof$;
SQL

echo "User profile read audience PostgreSQL 17 proof passed"
