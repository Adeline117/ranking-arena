#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MUTATION_MIGRATION="$ROOT_DIR/supabase/migrations/20260729154500_inactive_auth_subject_mutation_barrier.sql"
REQUEST_MIGRATION="$ROOT_DIR/supabase/migrations/20260729156500_inactive_auth_subject_request_admission.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo 'This integration proof requires PostgreSQL 17' >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/inactive-auth-request-admission-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55655
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_failure_matching() {
  local sql="$1"
  local label="$2"
  local pattern="$3"
  local failure_log="$LOG_DIR/$label.log"
  if psql_cmd -c "$sql" >"$failure_log" 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
  if ! rg -q "$pattern" "$failure_log"; then
    echo "Failure did not match $pattern: $label" >&2
    cat "$failure_log" >&2
    return 1
  fi
}

expect_migration_failure_matching() {
  local label="$1"
  local pattern="$2"
  local failure_log="$LOG_DIR/$label.log"
  if psql_cmd -f "$REQUEST_MIGRATION" >"$failure_log" 2>&1; then
    echo "Expected migration failure: $label" >&2
    return 1
  fi
  if ! rg -q "$pattern" "$failure_log"; then
    echo "Migration failure did not match $pattern: $label" >&2
    cat "$failure_log" >&2
    return 1
  fi
}

wait_for_subject_lock() {
  local user_id="$1"
  local attempt
  local acquired
  for attempt in $(seq 1 100); do
    acquired="$(psql_cmd -Atqc "SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended('account-recovery-admission:' || '$user_id'::uuid::text, 0))")"
    if [[ "$acquired" == 'f' ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "Timed out waiting for subject lock: $user_id" >&2
  return 1
}

ACTIVE_USER='11111111-1111-4111-8111-111111111111'
DELETED_USER='22222222-2222-4222-8222-222222222222'
BANNED_USER='33333333-3333-4333-8333-333333333333'
LEGACY_BANNED_USER='44444444-4444-4444-8444-444444444444'
EXPIRED_BAN_USER='55555555-5555-4555-8555-555555555555'
MISSING_USER='66666666-6666-4666-8666-666666666666'
READ_WINS_USER='77777777-7777-4777-8777-777777777777'
DELETE_WINS_USER='88888888-8888-4888-8888-888888888888'
RECOVERY_WINS_USER='99999999-9999-4999-8999-999999999999'

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT;
GRANT anon, authenticated, service_role TO authenticator;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE SCHEMA storage AUTHORIZATION postgres;

CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')
  )::uuid
$function$;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_self ON public.user_profiles
  FOR SELECT TO authenticated USING (id = (SELECT auth.uid()));

CREATE TABLE public.private_records (
  id integer PRIMARY KEY,
  user_id uuid NOT NULL,
  payload text NOT NULL
);
ALTER TABLE public.private_records OWNER TO postgres;
ALTER TABLE public.private_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY private_records_self ON public.private_records
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE TABLE public.realtime_private_events (
  id integer PRIMARY KEY,
  user_id uuid NOT NULL,
  payload text NOT NULL
);
ALTER TABLE public.realtime_private_events OWNER TO postgres;
ALTER TABLE public.realtime_private_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY realtime_events_self ON public.realtime_private_events
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

CREATE TABLE public.public_records (
  id integer PRIMARY KEY,
  payload text NOT NULL
);
ALTER TABLE public.public_records OWNER TO postgres;
ALTER TABLE public.public_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY public_records_read ON public.public_records
  FOR SELECT TO anon, authenticated USING (true);

CREATE TABLE public.unrestricted_public_records (
  id integer PRIMARY KEY,
  payload text NOT NULL
);
ALTER TABLE public.unrestricted_public_records OWNER TO postgres;

CREATE TABLE public.partitioned_private_records (
  id integer NOT NULL,
  user_id uuid NOT NULL,
  payload text NOT NULL
) PARTITION BY RANGE (id);
CREATE TABLE public.partitioned_private_records_low
  PARTITION OF public.partitioned_private_records FOR VALUES FROM (0) TO (100);
ALTER TABLE public.partitioned_private_records OWNER TO postgres;
ALTER TABLE public.partitioned_private_records_low OWNER TO postgres;
ALTER TABLE public.partitioned_private_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partitioned_private_records_low ENABLE ROW LEVEL SECURITY;
CREATE POLICY partition_parent_self ON public.partitioned_private_records
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY partition_leaf_self ON public.partitioned_private_records_low
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

CREATE TABLE storage.objects (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  name text NOT NULL
);
ALTER TABLE storage.objects OWNER TO postgres;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY storage_objects_self ON storage.objects
  FOR ALL TO authenticated
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));

GRANT USAGE ON SCHEMA public, storage TO anon, authenticated, authenticator, service_role;
GRANT SELECT ON public.public_records, public.unrestricted_public_records TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.user_profiles,
  public.private_records,
  public.realtime_private_events,
  public.partitioned_private_records,
  public.partitioned_private_records_low,
  storage.objects
TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public, storage TO service_role;

INSERT INTO public.user_profiles (
  id,
  deleted_at,
  banned_at,
  is_banned,
  ban_expires_at
) VALUES
  ('11111111-1111-4111-8111-111111111111', NULL, NULL, false, NULL),
  ('22222222-2222-4222-8222-222222222222', pg_catalog.clock_timestamp(), NULL, false, NULL),
  ('33333333-3333-4333-8333-333333333333', NULL, pg_catalog.clock_timestamp(), false, NULL),
  ('44444444-4444-4444-8444-444444444444', NULL, NULL, true, NULL),
  ('55555555-5555-4555-8555-555555555555', NULL, NULL, true, '2000-01-01T00:00:00Z'),
  ('77777777-7777-4777-8777-777777777777', NULL, NULL, false, NULL),
  ('88888888-8888-4888-8888-888888888888', NULL, NULL, false, NULL),
  ('99999999-9999-4999-8999-999999999999', pg_catalog.clock_timestamp(), NULL, false, NULL);

INSERT INTO public.private_records (id, user_id, payload) VALUES
  (1, '11111111-1111-4111-8111-111111111111', 'active-private'),
  (2, '22222222-2222-4222-8222-222222222222', 'deleted-private'),
  (3, '77777777-7777-4777-8777-777777777777', 'read-wins-private'),
  (4, '88888888-8888-4888-8888-888888888888', 'delete-wins-private'),
  (5, '99999999-9999-4999-8999-999999999999', 'recovery-wins-private');
INSERT INTO public.realtime_private_events VALUES
  (1, '11111111-1111-4111-8111-111111111111', 'active-realtime'),
  (2, '22222222-2222-4222-8222-222222222222', 'deleted-realtime');
INSERT INTO public.public_records VALUES (1, 'public');
INSERT INTO public.unrestricted_public_records VALUES (1, 'unrestricted-public');
INSERT INTO public.partitioned_private_records VALUES
  (1, '11111111-1111-4111-8111-111111111111', 'active-partition'),
  (2, '22222222-2222-4222-8222-222222222222', 'deleted-partition');
INSERT INTO storage.objects VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'active-object'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'deleted-object');

CREATE FUNCTION public.security_definer_private_record_count()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT pg_catalog.count(*) FROM public.private_records
$function$;
ALTER FUNCTION public.security_definer_private_record_count() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.security_definer_private_record_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.security_definer_private_record_count() TO authenticated;
SQL

psql_cmd -f "$MUTATION_MIGRATION" >/dev/null

# An existing operator hook is never overwritten, and the failed transaction
# must not leave any admission function or policy behind.
psql_cmd -c "ALTER ROLE authenticator SET pgrst.db_pre_request = 'public.foreign_hook'" >/dev/null
expect_migration_failure_matching \
  'foreign-pre-request-hook' \
  'refusing to replace existing PostgREST pre-request hook'
psql_cmd -Atqc "SELECT pg_catalog.to_regprocedure('public.enforce_active_authenticated_subject_pre_request()') IS NULL" | rg -qx 't'
psql_cmd -c 'ALTER ROLE authenticator RESET pgrst.db_pre_request' >/dev/null

psql_cmd -c "ALTER DATABASE postgres SET pgrst.db_pre_request = 'public.database_foreign_hook'" >/dev/null
expect_migration_failure_matching \
  'database-foreign-pre-request-hook' \
  'refusing to replace existing PostgREST pre-request hook'
psql_cmd -Atqc "SELECT pg_catalog.to_regprocedure('public.enforce_active_authenticated_subject_pre_request()') IS NULL" | rg -qx 't'
psql_cmd -c 'ALTER DATABASE postgres RESET pgrst.db_pre_request' >/dev/null

psql_cmd -f "$REQUEST_MIGRATION" >/dev/null
psql_cmd -f "$REQUEST_MIGRATION" >/dev/null

# A fresh authenticator connection receives the exact role configuration that
# PostgREST loads, then switches to the original JWT role before the hook runs.
psql_cmd -U authenticator -Atqc \
  "SELECT pg_catalog.current_setting('pgrst.db_pre_request', true)" |
  rg -qx 'public.enforce_active_authenticated_subject_pre_request'
psql_cmd -U authenticator -Atqc \
  "BEGIN; SET LOCAL ROLE authenticated; SELECT pg_catalog.set_config('request.jwt.claims', '{\"role\":\"authenticated\",\"sub\":\"$ACTIVE_USER\"}', true); SELECT public.enforce_active_authenticated_subject_pre_request(); COMMIT;" >/dev/null

psql_cmd <<SQL
BEGIN;
SET LOCAL ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"$ACTIVE_USER"}',
  true
);
SELECT public.enforce_active_authenticated_subject_pre_request();
SELECT payload FROM public.private_records WHERE user_id = '$ACTIVE_USER';
SELECT payload FROM public.realtime_private_events WHERE user_id = '$ACTIVE_USER';
SELECT name FROM storage.objects WHERE owner_id = '$ACTIVE_USER';
SELECT payload FROM public.partitioned_private_records WHERE id = 1;
SELECT payload FROM public.partitioned_private_records_low WHERE id = 1;
SELECT public.security_definer_private_record_count();
COMMIT;

BEGIN;
SET LOCAL ROLE anon;
SELECT pg_catalog.set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT public.enforce_active_authenticated_subject_pre_request();
SELECT payload FROM public.public_records;
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT public.enforce_active_authenticated_subject_pre_request();
SELECT pg_catalog.count(*) FROM public.private_records;
COMMIT;

BEGIN;
SET LOCAL ROLE postgres;
SELECT public.enforce_active_authenticated_subject_pre_request();
SELECT pg_catalog.count(*) FROM public.private_records;
COMMIT;

SELECT public.require_active_authenticated_subject_request();
SELECT public.assert_active_authenticated_subject_request_admission();
SQL

for user_id in \
  "$DELETED_USER" \
  "$BANNED_USER" \
  "$LEGACY_BANNED_USER" \
  "$MISSING_USER"; do
  expect_failure_matching \
    "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$user_id\"}'; SELECT public.enforce_active_authenticated_subject_pre_request();" \
    "inactive-pre-request-$user_id" \
    'authenticated account is not active'
done

psql_cmd -Atqc \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$EXPIRED_BAN_USER\"}'; SELECT public.require_active_authenticated_subject_request();" |
  rg -qx 't'

expect_failure_matching \
  "SET ROLE authenticated; RESET request.jwt.claims; RESET request.jwt.claim.role; RESET request.jwt.claim.sub; SELECT public.enforce_active_authenticated_subject_pre_request();" \
  'missing-authenticated-claims' \
  'authenticated request JWT identity is unavailable'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = 'not-json'; SELECT public.enforce_active_authenticated_subject_pre_request();" \
  'malformed-authenticated-claims' \
  'authenticated request JWT claims are malformed'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$ACTIVE_USER\"}'; SET request.jwt.claim.role = 'anon'; SELECT public.enforce_active_authenticated_subject_pre_request();" \
  'conflicting-authenticated-role' \
  'authenticated request JWT role claims conflict'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$ACTIVE_USER\"}'; SET request.jwt.claim.sub = '$DELETED_USER'; SELECT public.enforce_active_authenticated_subject_pre_request();" \
  'conflicting-authenticated-subject' \
  'authenticated request JWT subject claims conflict'
expect_failure_matching \
  "SET ROLE anon; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$ACTIVE_USER\"}'; SELECT public.enforce_active_authenticated_subject_pre_request();" \
  'conflicting-database-role' \
  'authenticated request JWT identity is unavailable'

# RLS repeats admission for Storage/Realtime, even outside PostgREST. A deleted
# JWT cannot turn a public permissive policy, an owner policy, or a direct leaf
# query into a data leak.
for target in \
  'public.private_records' \
  'public.realtime_private_events' \
  'public.public_records' \
  'public.partitioned_private_records' \
  'public.partitioned_private_records_low' \
  'storage.objects'; do
  expect_failure_matching \
    "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; SELECT * FROM $target;" \
    "deleted-rls-${target//./-}" \
    'authenticated account is not active'
done

# Pure-read SECURITY DEFINER functions bypass RLS, but never the registered
# Data API pre-request hook.
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; SELECT public.enforce_active_authenticated_subject_pre_request(); SELECT public.security_definer_private_record_count();" \
  'deleted-security-definer-read' \
  'authenticated account is not active'

# Tables and partition leaves introduced by a future migration converge through
# one installer call, including the earlier mutation layer.
psql_cmd <<'SQL'
CREATE TABLE public.future_private_records (
  id integer PRIMARY KEY,
  user_id uuid NOT NULL
);
ALTER TABLE public.future_private_records OWNER TO postgres;
ALTER TABLE public.future_private_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY future_private_self ON public.future_private_records
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
GRANT SELECT, INSERT ON public.future_private_records TO authenticated;
INSERT INTO public.future_private_records VALUES
  (1, '22222222-2222-4222-8222-222222222222');

CREATE TABLE storage.future_private_objects (
  id integer PRIMARY KEY,
  owner_id uuid NOT NULL
);
ALTER TABLE storage.future_private_objects OWNER TO postgres;
ALTER TABLE storage.future_private_objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY future_objects_self ON storage.future_private_objects
  FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
GRANT SELECT ON storage.future_private_objects TO authenticated;
INSERT INTO storage.future_private_objects VALUES
  (1, '22222222-2222-4222-8222-222222222222');

CREATE TABLE public.future_partitioned_records (
  id integer NOT NULL,
  user_id uuid NOT NULL
) PARTITION BY RANGE (id);
CREATE TABLE public.future_partitioned_records_low
  PARTITION OF public.future_partitioned_records FOR VALUES FROM (0) TO (100);
ALTER TABLE public.future_partitioned_records OWNER TO postgres;
ALTER TABLE public.future_partitioned_records_low OWNER TO postgres;
ALTER TABLE public.future_partitioned_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.future_partitioned_records_low ENABLE ROW LEVEL SECURITY;
CREATE POLICY future_partition_parent_self ON public.future_partitioned_records
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY future_partition_leaf_self ON public.future_partitioned_records_low
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
GRANT SELECT ON public.future_partitioned_records, public.future_partitioned_records_low
  TO authenticated;

SELECT public.install_active_authenticated_subject_request_admission();
SELECT public.assert_active_authenticated_subject_request_admission();

DO $coverage$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polname = '000_active_authenticated_subject_request_guard'
      AND policy.polrelid IN (
        'public.future_private_records'::regclass,
        'storage.future_private_objects'::regclass,
        'public.future_partitioned_records'::regclass,
        'public.future_partitioned_records_low'::regclass
      )
      AND NOT policy.polpermissive
  ) <> 4 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgname = '000_active_authenticated_subject_statement_guard'
      AND trigger_row.tgrelid IN (
        'public.future_private_records'::regclass,
        'storage.future_private_objects'::regclass,
        'public.future_partitioned_records'::regclass,
        'public.future_partitioned_records_low'::regclass
      )
      AND trigger_row.tgtype = 62
  ) <> 4 THEN
    RAISE EXCEPTION 'future request admission coverage is incomplete';
  END IF;
END
$coverage$;
SQL

expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; SELECT * FROM public.future_private_records;" \
  'deleted-future-rls' \
  'authenticated account is not active'

# Reader wins: its shared transaction lock lets concurrent readers proceed but
# holds the deletion transition until this request completes. The lifecycle row
# trigger re-enters the exclusive key after taking the profile row lock without
# deadlocking the already-admitted read.
psql_cmd >"$LOG_DIR/read-wins-holder.log" 2>&1 <<SQL &
BEGIN;
SET ROLE authenticated;
SET request.jwt.claims = '{"role":"authenticated","sub":"$READ_WINS_USER"}';
SELECT public.require_active_authenticated_subject_request();
SELECT pg_catalog.pg_sleep(1);
SELECT payload FROM public.private_records WHERE user_id = '$READ_WINS_USER';
COMMIT;
SQL
read_holder_pid=$!
wait_for_subject_lock "$READ_WINS_USER"
psql_cmd -c "SET ROLE service_role; UPDATE public.user_profiles SET deleted_at = pg_catalog.clock_timestamp() WHERE id = '$READ_WINS_USER';" >/dev/null
wait "$read_holder_pid"
rg -q 'read-wins-private' "$LOG_DIR/read-wins-holder.log"

# Deletion wins: a reader queued behind the exclusive lifecycle lock observes
# the committed tombstone, rather than using a snapshot taken before its wait.
psql_cmd >"$LOG_DIR/delete-wins-holder.log" 2>&1 <<SQL &
BEGIN;
SET ROLE service_role;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:' || '$DELETE_WINS_USER'::uuid::text,
    0
  )
);
UPDATE public.user_profiles
SET deleted_at = pg_catalog.clock_timestamp()
WHERE id = '$DELETE_WINS_USER';
SELECT pg_catalog.pg_sleep(1);
COMMIT;
SQL
delete_holder_pid=$!
wait_for_subject_lock "$DELETE_WINS_USER"
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETE_WINS_USER\"}'; SELECT * FROM public.private_records WHERE user_id = '$DELETE_WINS_USER';" \
  'delete-wins-read-race' \
  'authenticated account is not active'
wait "$delete_holder_pid"

# Recovery wins under the same ordering: the queued reader sees the restored
# active state after commit and returns its private row.
psql_cmd >"$LOG_DIR/recovery-wins-holder.log" 2>&1 <<SQL &
BEGIN;
SET ROLE service_role;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:' || '$RECOVERY_WINS_USER'::uuid::text,
    0
  )
);
UPDATE public.user_profiles
SET deleted_at = NULL
WHERE id = '$RECOVERY_WINS_USER';
SELECT pg_catalog.pg_sleep(1);
COMMIT;
SQL
recovery_holder_pid=$!
wait_for_subject_lock "$RECOVERY_WINS_USER"
psql_cmd -Atqc \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$RECOVERY_WINS_USER\"}'; SELECT payload FROM public.private_records WHERE user_id = '$RECOVERY_WINS_USER';" |
  rg -qx 'recovery-wins-private'
wait "$recovery_holder_pid"

psql_cmd -c 'SET ROLE service_role; SELECT public.assert_active_authenticated_subject_request_admission();' >/dev/null

echo 'inactive authenticated-subject request admission pg17 proof passed'
