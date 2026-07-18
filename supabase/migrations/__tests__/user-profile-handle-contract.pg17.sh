#!/usr/bin/env bash

# PostgreSQL 17 proof for profile-handle repair, validation and signup races.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716179000_user_profile_handle_contract.sql"
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

TMP_ROOT="$(mktemp -d /tmp/user-profile-handle-contract-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55579
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

expect_failure() {
  local sql="$1"
  local label="$2"
  local needle="${3:-}"
  local failure_log="$TMP_ROOT/${label}.log"
  if psql_cmd -Atqc "$sql" >"$failure_log" 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
  if [[ -n "$needle" ]] && ! grep -Fq "$needle" "$failure_log"; then
    cat "$failure_log" >&2
    echo "Missing failure evidence for $label: $needle" >&2
    return 1
  fi
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

expect_managed_migration_failure() {
  local needle="$1"
  local label="$2"
  local failure_log="$TMP_ROOT/${label}.log"
  if psql_cmd \
    -c 'SET ROLE postgres' \
    -f "$MIGRATION" >"$failure_log" 2>&1; then
    echo "Expected managed migration failure: $label" >&2
    return 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    cat "$failure_log" >&2
    echo "Missing managed migration failure evidence: $needle" >&2
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

ALTER SCHEMA public OWNER TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE auth.users OWNER TO postgres;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  email text,
  handle text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE public.user_profiles OWNER TO postgres;

CREATE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  INSERT INTO public.user_profiles (id, email, handle)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'handle', 'legacy')
  );
  RETURN NEW;
END
$function$;

CREATE FUNCTION public.legacy_auth_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEW;
END
$function$;

INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'legacy@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'admin@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'reserved@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'dot@example.com'),
  ('55555555-5555-4555-8555-555555555555', 'foo-one@example.com'),
  ('66666666-6666-4666-8666-666666666666', 'foo-two@example.com'),
  ('77777777-7777-4777-8777-777777777777', 'punct-one@example.com'),
  ('88888888-8888-4888-8888-888888888888', 'punct-two@example.com'),
  ('99999999-9999-4999-8999-999999999999', 'null@example.com'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'empty@example.com'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'unicode@example.com'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'missing@example.com');

INSERT INTO public.user_profiles (id, email, handle, created_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'legacy@example.com', 'legacy.name', '2024-01-01'),
  ('22222222-2222-4222-8222-222222222222', 'admin@example.com', 'Admin', '2024-01-02'),
  ('33333333-3333-4333-8333-333333333333', 'reserved@example.com', ' admin ', '2024-01-03'),
  ('44444444-4444-4444-8444-444444444444', 'dot@example.com', ' dotted.name ', '2024-01-04'),
  ('55555555-5555-4555-8555-555555555555', 'foo-one@example.com', 'Foo', '2024-01-05'),
  ('66666666-6666-4666-8666-666666666666', 'foo-two@example.com', 'foo', '2024-01-06'),
  ('77777777-7777-4777-8777-777777777777', 'punct-one@example.com', 'foo!', '2024-01-07'),
  ('88888888-8888-4888-8888-888888888888', 'punct-two@example.com', 'foo?', '2024-01-08'),
  ('99999999-9999-4999-8999-999999999999', 'null@example.com', NULL, '2024-01-09'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'empty@example.com', '!!!', '2024-01-10'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'unicode@example.com', U&'\30AB\3099', '2024-01-11');

CREATE TRIGGER old_auth_profile_creator
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.legacy_auth_trigger();
SQL

# A function overload and an index-name collision must fail before mutating any
# profile data or historical trigger definitions.
psql_cmd <<'SQL'
CREATE FUNCTION public.handle_new_user(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT $1
$function$;
SQL
expect_migration_failure \
  'unexpected profile handle function overload exists' \
  'overload-preflight'
if [[ "$(psql_cmd -Atqc "SELECT handle FROM public.user_profiles WHERE id = '33333333-3333-4333-8333-333333333333'")" != " admin " ]]; then
  echo "Overload preflight partially repaired profile data" >&2
  exit 1
fi
psql_cmd -c 'DROP FUNCTION public.handle_new_user(text)' >/dev/null

psql_cmd <<'SQL'
CREATE TABLE public.handle_index_shadow (handle text);
CREATE INDEX user_profiles_handle_lower_unique
  ON public.handle_index_shadow (pg_catalog.lower(handle));
SQL
expect_migration_failure \
  'profile handle index name belongs to another relation' \
  'index-name-preflight'
psql_cmd <<'SQL'
DROP INDEX public.user_profiles_handle_lower_unique;
DROP TABLE public.handle_index_shadow;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $repair_proof$
DECLARE
  v_case_suffix text := 'foo_' || pg_catalog.left(
    pg_catalog.md5('66666666-6666-4666-8666-666666666666:0'),
    10
  );
  v_punct_suffix text := 'foo__' || pg_catalog.left(
    pg_catalog.md5('88888888-8888-4888-8888-888888888888:0'),
    10
  );
BEGIN
  IF (SELECT handle FROM public.user_profiles WHERE id =
      '11111111-1111-4111-8111-111111111111') <> 'legacy.name'
    OR (SELECT handle FROM public.user_profiles WHERE id =
      '22222222-2222-4222-8222-222222222222') <> 'Admin'
    OR (SELECT handle FROM public.user_profiles WHERE id =
      '33333333-3333-4333-8333-333333333333') <> 'admin_33333333'
    OR (SELECT handle FROM public.user_profiles WHERE id =
      '44444444-4444-4444-8444-444444444444') <> 'dotted_name'
    OR (SELECT handle FROM public.user_profiles WHERE id =
      '55555555-5555-4555-8555-555555555555') <> 'Foo'
    OR (SELECT handle FROM public.user_profiles WHERE id =
      '66666666-6666-4666-8666-666666666666') <> v_case_suffix
    OR (SELECT handle FROM public.user_profiles WHERE id =
      '77777777-7777-4777-8777-777777777777') <> 'foo_'
    OR (SELECT handle FROM public.user_profiles WHERE id =
      '88888888-8888-4888-8888-888888888888') <> v_punct_suffix
    OR (SELECT handle FROM public.user_profiles WHERE id =
      '99999999-9999-4999-8999-999999999999') <>
        'user_9999999999994999899999999'
    OR (SELECT handle FROM public.user_profiles WHERE id =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') <>
        'user_aaaaaaaaaaaa4aaa8aaaaaaaa'
    OR (SELECT handle FROM public.user_profiles WHERE id =
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') <> U&'\30AC'
    OR (SELECT handle FROM public.user_profiles WHERE id =
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc') <>
        'user_cccccccccccc4ccc8cccccccc'
  THEN
    RAISE EXCEPTION 'deterministic profile handle repair mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM auth.users AS auth_user
    LEFT JOIN public.user_profiles AS profile ON profile.id = auth_user.id
    WHERE profile.id IS NULL
  ) OR EXISTS (
    SELECT pg_catalog.lower(profile.handle)
    FROM public.user_profiles AS profile
    GROUP BY pg_catalog.lower(profile.handle)
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'profile backfill or lower uniqueness proof failed';
  END IF;
END
$repair_proof$;
SQL

# Existing legacy dotted/reserved handles can be retained, but every new or
# changed handle follows the strict URL-segment contract.
psql_cmd -Atqc \
  "UPDATE public.user_profiles SET handle = handle WHERE id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')" \
  >/dev/null
expect_failure \
  "UPDATE public.user_profiles SET handle = 'new.name' WHERE id = '33333333-3333-4333-8333-333333333333'" \
  'changed-dot' \
  'invalid profile handle'
expect_failure \
  "UPDATE public.user_profiles SET handle = 'support' WHERE id = '33333333-3333-4333-8333-333333333333'" \
  'changed-reserved' \
  'reserved profile handle'
expect_failure \
  "UPDATE public.user_profiles SET handle = ' padded ' WHERE id = '33333333-3333-4333-8333-333333333333'" \
  'changed-whitespace' \
  'invalid profile handle'
expect_failure \
  "UPDATE public.user_profiles SET handle = U&'\\30AB\\3099' WHERE id = '33333333-3333-4333-8333-333333333333'" \
  'changed-nfd' \
  'invalid profile handle'
expect_failure \
  "UPDATE public.user_profiles SET handle = 'Foo' WHERE id = '33333333-3333-4333-8333-333333333333'" \
  'changed-case-collision'
psql_cmd -Atqc \
  "UPDATE public.user_profiles SET handle = '交易者_한글' WHERE id = '33333333-3333-4333-8333-333333333333'" \
  >/dev/null

# Signup provisioning sanitizes metadata, avoids reserved names and falls back
# to the email local part without exposing either trigger function.
psql_cmd <<'SQL'
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'reserved-new@example.com', '{"handle":"root"}'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'dot-new@example.com', '{"handle":"dot.name!"}'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'mail.local@example.com', '{"handle":""}');

DO $signup_proof$
BEGIN
  IF (SELECT handle FROM public.user_profiles WHERE id =
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd') <> 'root_dddddddddd'
    OR (SELECT handle FROM public.user_profiles WHERE id =
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') <> 'dot_name_'
    OR (SELECT handle FROM public.user_profiles WHERE id =
      'ffffffff-ffff-4fff-8fff-ffffffffffff') <> 'mail_local'
    OR pg_catalog.has_function_privilege(
      'authenticated', 'public.handle_new_user()', 'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.enforce_user_profile_handle_contract()',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'signup sanitization or function privacy proof failed';
  END IF;
END
$signup_proof$;
SQL

# Keep the first transaction's profile insert uncommitted while the second
# signup requests the same case-insensitive handle.  The waiter must retry with
# its deterministic suffix after the unique conflict is released.
psql_cmd >"$TMP_ROOT/race-holder.log" 2>&1 <<'SQL' &
BEGIN;
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES (
  '10101010-1010-4010-8010-101010101010',
  'race-one@example.com',
  '{"handle":"Race"}'
);
SELECT pg_catalog.pg_sleep(1.25) /* profile-handle-race-holder */;
COMMIT;
SQL
RACE_HOLDER_PID=$!
for _ in {1..60}; do
  if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE query LIKE '%profile-handle-race-holder%' AND state = 'active'")" == "1" ]]; then
    break
  fi
  sleep 0.05
done
psql_cmd >"$TMP_ROOT/race-waiter.log" 2>&1 <<'SQL' &
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES (
  '20202020-2020-4020-8020-202020202020',
  'race-two@example.com',
  '{"handle":"race"}'
);
SQL
RACE_WAITER_PID=$!
if ! wait "$RACE_HOLDER_PID"; then
  cat "$TMP_ROOT/race-holder.log" >&2
  exit 1
fi
if ! wait "$RACE_WAITER_PID"; then
  cat "$TMP_ROOT/race-waiter.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $race_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.user_profiles
    WHERE id IN (
      '10101010-1010-4010-8010-101010101010',
      '20202020-2020-4020-8020-202020202020'
    )
  ) <> 2 OR (
    SELECT pg_catalog.count(DISTINCT pg_catalog.lower(handle))
    FROM public.user_profiles
    WHERE id IN (
      '10101010-1010-4010-8010-101010101010',
      '20202020-2020-4020-8020-202020202020'
    )
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM public.user_profiles
    WHERE id IN (
      '10101010-1010-4010-8010-101010101010',
      '20202020-2020-4020-8020-202020202020'
    ) AND pg_catalog.lower(handle) = 'race'
  ) <> 1 THEN
    RAISE EXCEPTION 'concurrent signup handle allocation failed';
  END IF;
END
$race_proof$;
SQL

# Replay repairs data and object drift, removes duplicate historical auth
# triggers and restores private postgres-owned definers.
psql_cmd <<'SQL'
DROP TRIGGER trg_user_profiles_05_handle_contract ON public.user_profiles;
ALTER TABLE public.user_profiles
  DROP CONSTRAINT user_profiles_handle_shape_check;
DROP INDEX public.user_profiles_handle_lower_unique;
CREATE INDEX user_profiles_handle_lower_unique
  ON public.user_profiles (handle);

UPDATE public.user_profiles
SET handle = CASE id
  WHEN '11111111-1111-4111-8111-111111111111' THEN 'Replay'
  WHEN '22222222-2222-4222-8222-222222222222' THEN 'replay'
  WHEN '44444444-4444-4444-8444-444444444444' THEN ' bad.name '
  ELSE handle
END
WHERE id IN (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '44444444-4444-4444-8444-444444444444'
);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.enforce_user_profile_handle_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  RAISE EXCEPTION 'drifted handle validator must be removed before backfill';
END
$function$;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_user_profile_handle_contract()
  TO authenticated, service_role;
CREATE TRIGGER duplicate_auth_profile_creator
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE TRIGGER trg_user_profiles_05_handle_contract
BEFORE INSERT OR UPDATE OF handle ON public.user_profiles
FOR EACH ROW EXECUTE FUNCTION public.enforce_user_profile_handle_contract();

-- Both drifted auth triggers are currently no-ops, leaving a profile gap for
-- replay to backfill after it removes the deliberately hostile validator.
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES (
  '30303030-3030-4030-8030-303030303030',
  'replay-missing@example.com',
  '{"handle":"ignored-by-drift"}'
);
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $replay_proof$
DECLARE
  v_postgres oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.handle IS NULL
      OR profile.handle <> pg_catalog.btrim(profile.handle)
      OR profile.handle IS NOT NFC NORMALIZED
  ) OR EXISTS (
    SELECT pg_catalog.lower(profile.handle)
    FROM public.user_profiles AS profile
    GROUP BY pg_catalog.lower(profile.handle)
    HAVING pg_catalog.count(*) > 1
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.id = '30303030-3030-4030-8030-303030303030'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'auth.users'::pg_catalog.regclass
      AND trigger_row.tgfoid =
        'public.handle_new_user()'::pg_catalog.regprocedure
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (
      'public.handle_new_user()'::pg_catalog.regprocedure,
      'public.enforce_user_profile_handle_contract()'::pg_catalog.regprocedure
    )
      AND (
        function_row.proowner <> v_postgres
        OR NOT function_row.prosecdef
        OR function_row.proconfig <>
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
      )
  ) OR pg_catalog.has_function_privilege(
    'authenticated', 'public.handle_new_user()', 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    'public.enforce_user_profile_handle_contract()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'profile handle replay did not converge';
  END IF;
END
$replay_proof$;
SQL

# Hosted Supabase keeps auth.users under supabase_auth_admin while the postgres
# migration identity is a non-superuser BYPASSRLS role.  In that topology the
# migration must preserve the already-canonical auth trigger OID while repairing
# the function in place, including on replay.
psql_cmd <<'SQL'
CREATE ROLE supabase_auth_admin NOLOGIN;

ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.users OWNER TO supabase_auth_admin;
ALTER SCHEMA auth OWNER TO supabase_auth_admin;
GRANT USAGE ON SCHEMA auth TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE, TRIGGER ON auth.users TO postgres;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  -- managed-success-function-drift
  RETURN NEW;
END
$function$;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO authenticated;

ALTER ROLE postgres NOSUPERUSER BYPASSRLS;
SQL

MANAGED_TRIGGER_OID_BEFORE="$(
  psql_cmd -Atqc "
    SELECT trigger_row.oid
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'auth.users'::pg_catalog.regclass
      AND trigger_row.tgname = 'on_auth_user_created'
      AND NOT trigger_row.tgisinternal
  "
)"

psql_cmd -c 'SET ROLE postgres' -f "$MIGRATION" >/dev/null
psql_cmd -c 'SET ROLE postgres' -f "$MIGRATION" >/dev/null

MANAGED_TRIGGER_OID_AFTER="$(
  psql_cmd -Atqc "
    SELECT trigger_row.oid
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'auth.users'::pg_catalog.regclass
      AND trigger_row.tgname = 'on_auth_user_created'
      AND NOT trigger_row.tgisinternal
  "
)"
if [[ -z "$MANAGED_TRIGGER_OID_BEFORE" ]] \
  || [[ "$MANAGED_TRIGGER_OID_AFTER" != "$MANAGED_TRIGGER_OID_BEFORE" ]]; then
  echo "Managed auth replay replaced the canonical trigger OID" >&2
  exit 1
fi

psql_cmd <<'SQL'
SET ROLE postgres;

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES (
  '40404040-4040-4040-8040-404040404040',
  'managed@example.com',
  '{"handle":"Managed"}'
);

DO $managed_replay_proof$
DECLARE
  v_postgres oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
BEGIN
  IF (
    SELECT owner_role.rolname
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = relation.relowner
    WHERE relation.oid = 'auth.users'::pg_catalog.regclass
  ) <> 'supabase_auth_admin'
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.rolname = CURRENT_USER
        AND role_row.rolname = 'postgres'
        AND NOT role_row.rolsuper
        AND role_row.rolbypassrls
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = 'auth.users'::pg_catalog.regclass
        AND trigger_row.tgname = 'on_auth_user_created'
        AND trigger_row.tgfoid =
          'public.handle_new_user()'::pg_catalog.regprocedure
        AND trigger_row.tgenabled = 'O'
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgtype = 5
        AND trigger_row.tgattr = ''::pg_catalog.int2vector
        AND trigger_row.tgqual IS NULL
        AND trigger_row.tgconstraint = 0
        AND NOT trigger_row.tgdeferrable
        AND NOT trigger_row.tginitdeferred
        AND trigger_row.tgnargs = 0
        AND pg_catalog.octet_length(trigger_row.tgargs) = 0
    )
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = 'auth.users'::pg_catalog.regclass
        AND trigger_row.tgfoid =
          'public.handle_new_user()'::pg_catalog.regprocedure
        AND NOT trigger_row.tgisinternal
    ) <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid =
          'public.handle_new_user()'::pg_catalog.regprocedure
        AND function_row.proowner = v_postgres
        AND function_row.prosecdef
        AND function_row.proconfig =
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.strpos(
          function_row.prosrc,
          'NEW.raw_user_meta_data'
        ) > 0
        AND pg_catalog.strpos(
          function_row.prosrc,
          'managed-success-function-drift'
        ) = 0
    )
    OR pg_catalog.has_function_privilege(
      'authenticated',
      'public.handle_new_user()',
      'EXECUTE'
    )
    OR (
      SELECT handle
      FROM public.user_profiles
      WHERE id = '40404040-4040-4040-8040-404040404040'
    ) <> 'Managed'
  THEN
    RAISE EXCEPTION 'managed auth replay did not preserve trigger authority';
  END IF;
END
$managed_replay_proof$;

RESET ROLE;
SQL

# A managed trigger mismatch must fail before the function can be replaced.
# The failed transaction leaves both the trigger OID/disabled state and the
# deliberately drifted function source untouched.
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  -- managed-atomic-failure-sentinel
  RETURN NEW;
END
$function$;
ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created;
SQL

expect_managed_migration_failure \
  'managed auth profile provisioning trigger is incompatible' \
  'managed-trigger-drift'

if [[ "$(psql_cmd -Atqc "
  SELECT trigger_row.oid::text || ':' || trigger_row.tgenabled::text
  FROM pg_catalog.pg_trigger AS trigger_row
  WHERE trigger_row.tgrelid = 'auth.users'::pg_catalog.regclass
    AND trigger_row.tgname = 'on_auth_user_created'
    AND NOT trigger_row.tgisinternal
")" != "${MANAGED_TRIGGER_OID_BEFORE}:D" ]]; then
  echo "Failed managed migration did not preserve the drifted trigger atomically" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "
  SELECT (pg_catalog.strpos(
    function_row.prosrc,
    'managed-atomic-failure-sentinel'
  ) > 0)::text
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.handle_new_user()'::pg_catalog.regprocedure
")" != "true" ]]; then
  echo "Failed managed migration partially replaced the provisioner" >&2
  exit 1
fi

echo "User profile handle contract PostgreSQL 17 proof passed"
