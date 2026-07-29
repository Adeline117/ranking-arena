#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729154500_inactive_auth_subject_mutation_barrier.sql"
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

TMP_ROOT="$(mktemp -d /tmp/inactive-auth-subject-barrier-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55645
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
  echo "Timed out waiting for lifecycle lock: $user_id" >&2
  return 1
}

ACTIVE_USER='11111111-1111-4111-8111-111111111111'
DELETED_USER='22222222-2222-4222-8222-222222222222'
BANNED_USER='33333333-3333-4333-8333-333333333333'
LEGACY_BANNED_USER='44444444-4444-4444-8444-444444444444'
EXPIRED_BAN_USER='55555555-5555-4555-8555-555555555555'
HARD_DELETED_USER='66666666-6666-4666-8666-666666666666'
PROVISIONED_USER='77777777-7777-4777-8777-777777777777'
DELETE_RACE_USER='88888888-8888-4888-8888-888888888888'
RECOVERY_RACE_USER='99999999-9999-4999-8999-999999999999'
HARD_DELETE_RACE_USER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
MISSING_USER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

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
  handle text,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.mutation_probe (
  id integer PRIMARY KEY,
  note text NOT NULL
);
CREATE TABLE public.truncate_probe (
  id integer PRIMARY KEY
);
CREATE TABLE public.ordered_probe (
  id integer PRIMARY KEY
);
CREATE TABLE public.partition_probe (
  id integer NOT NULL,
  note text NOT NULL
) PARTITION BY RANGE (id);
CREATE TABLE public.partition_probe_low
  PARTITION OF public.partition_probe FOR VALUES FROM (0) TO (100);
CREATE TABLE storage.objects (
  id text PRIMARY KEY,
  owner_id uuid NOT NULL,
  payload text NOT NULL
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.mutation_probe OWNER TO postgres;
ALTER TABLE public.truncate_probe OWNER TO postgres;
ALTER TABLE public.ordered_probe OWNER TO postgres;
ALTER TABLE public.partition_probe OWNER TO postgres;
ALTER TABLE public.partition_probe_low OWNER TO postgres;
ALTER TABLE storage.objects OWNER TO postgres;

GRANT USAGE ON SCHEMA public, storage, auth
  TO anon, authenticated, authenticator, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER
  ON ALL TABLES IN SCHEMA public, storage
  TO authenticated, service_role;
GRANT INSERT ON public.mutation_probe TO anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;

CREATE FUNCTION public.security_definer_insert(p_id integer, p_note text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  INSERT INTO public.mutation_probe (id, note) VALUES (p_id, p_note)
$function$;
CREATE FUNCTION public.security_definer_truncate()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  TRUNCATE TABLE public.truncate_probe
$function$;
ALTER FUNCTION public.security_definer_insert(integer, text) OWNER TO postgres;
ALTER FUNCTION public.security_definer_truncate() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.security_definer_insert(integer, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.security_definer_truncate()
  TO authenticated, service_role;

CREATE FUNCTION public.raise_if_order_guard_lost()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'late statement trigger executed';
END
$function$;
ALTER FUNCTION public.raise_if_order_guard_lost() OWNER TO postgres;
CREATE TRIGGER zzz_late_statement_trigger
BEFORE INSERT ON public.ordered_probe
FOR EACH STATEMENT
EXECUTE FUNCTION public.raise_if_order_guard_lost();

INSERT INTO public.user_profiles (
  id,
  handle,
  deleted_at,
  banned_at,
  is_banned,
  ban_expires_at
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'active', NULL, NULL, false, NULL),
  ('22222222-2222-4222-8222-222222222222', 'deleted', '2026-07-29', NULL, false, NULL),
  ('33333333-3333-4333-8333-333333333333', 'banned', NULL, '2026-07-29', false, NULL),
  ('44444444-4444-4444-8444-444444444444', 'legacy-ban', NULL, NULL, true, NULL),
  ('55555555-5555-4555-8555-555555555555', 'expired-ban', NULL, NULL, true, '2000-01-01'),
  ('66666666-6666-4666-8666-666666666666', 'hard-delete', '2026-07-29', NULL, false, NULL),
  ('88888888-8888-4888-8888-888888888888', 'delete-race', NULL, NULL, false, NULL),
  ('99999999-9999-4999-8999-999999999999', 'recovery-race', '2026-07-29', NULL, false, NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'hard-delete-race', '2026-07-29', NULL, false, NULL);

INSERT INTO public.mutation_probe (id, note) VALUES
  (1, 'update-seed'),
  (2, 'delete-seed');
INSERT INTO public.truncate_probe (id) VALUES (1);
INSERT INTO storage.objects (id, owner_id, payload) VALUES
  ('update-seed', '11111111-1111-4111-8111-111111111111', 'before'),
  ('delete-seed', '11111111-1111-4111-8111-111111111111', 'before');
SQL

psql_cmd -f "$MIGRATION" >/dev/null

# Active and expired legacy-ban identities remain usable for ordinary writes.
psql_cmd -c "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$ACTIVE_USER\"}'; INSERT INTO public.mutation_probe VALUES (100, 'active'); UPDATE public.mutation_probe SET note = 'active-update' WHERE id = 1; DELETE FROM public.mutation_probe WHERE id = 2; SELECT public.security_definer_insert(101, 'active-security-definer');" >/dev/null
psql_cmd -c "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$EXPIRED_BAN_USER\"}'; INSERT INTO public.mutation_probe VALUES (102, 'expired-ban-is-active');" >/dev/null

# A valid anonymous request and trusted backends are outside this authenticated
# account barrier. Missing claims are allowed only when the database role itself
# is not authenticated.
psql_cmd -c "SET ROLE anon; SET request.jwt.claims = '{\"role\":\"anon\"}'; INSERT INTO public.mutation_probe VALUES (103, 'anon');" >/dev/null
psql_cmd -c "INSERT INTO public.mutation_probe VALUES (104, 'postgres-background');" >/dev/null
psql_cmd -c "SET ROLE service_role; RESET request.jwt.claims; INSERT INTO public.mutation_probe VALUES (105, 'service-no-claims');" >/dev/null
psql_cmd -c "SET ROLE service_role; SET request.jwt.claims = '{\"role\":\"service_role\"}'; SELECT public.security_definer_insert(106, 'service-security-definer');" >/dev/null

# Trusted provisioning may create the first profile while no profile exists.
psql_cmd -c "SET ROLE service_role; SET request.jwt.claims = '{\"role\":\"service_role\"}'; INSERT INTO public.user_profiles (id, handle) VALUES ('$PROVISIONED_USER', 'provisioned');" >/dev/null
if [[ "$(psql_cmd -Atqc "SELECT handle FROM public.user_profiles WHERE id = '$PROVISIONED_USER'")" != 'provisioned' ]]; then
  echo 'Trusted first-profile provisioning was rejected' >&2
  exit 1
fi

# A hard-deleted subject cannot use its still-signed JWT to recreate a profile.
psql_cmd -c "SET ROLE service_role; DELETE FROM public.user_profiles WHERE id = '$HARD_DELETED_USER';" >/dev/null
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$HARD_DELETED_USER\"}'; INSERT INTO public.user_profiles (id, handle) VALUES ('$HARD_DELETED_USER', 'recreated');" \
  'hard-deleted-profile-reinsert' \
  'authenticated account is not active'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$MISSING_USER\"}'; INSERT INTO public.user_profiles (id, handle) VALUES ('$MISSING_USER', 'forged-first-row');" \
  'missing-profile-self-provision' \
  'authenticated account is not active'

# Deleted JWTs cannot mutate any public operation by any command type.
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; INSERT INTO public.mutation_probe VALUES (200, 'blocked');" \
  'deleted-public-insert' \
  'authenticated account is not active'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; UPDATE public.mutation_probe SET note = 'blocked' WHERE id = 1;" \
  'deleted-public-update' \
  'authenticated account is not active'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; DELETE FROM public.mutation_probe WHERE id = 1;" \
  'deleted-public-delete' \
  'authenticated account is not active'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; TRUNCATE public.mutation_probe;" \
  'deleted-public-truncate' \
  'permission denied|authenticated account is not active'

# The same barrier covers Supabase Storage's database boundary.
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; INSERT INTO storage.objects VALUES ('blocked', '$DELETED_USER', 'blocked');" \
  'deleted-storage-insert' \
  'authenticated account is not active'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; UPDATE storage.objects SET payload = 'blocked' WHERE id = 'update-seed';" \
  'deleted-storage-update' \
  'authenticated account is not active'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; DELETE FROM storage.objects WHERE id = 'delete-seed';" \
  'deleted-storage-delete' \
  'authenticated account is not active'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; TRUNCATE storage.objects;" \
  'deleted-storage-truncate' \
  'permission denied|authenticated account is not active'

# current_user becomes postgres in these functions, but request claims and the
# original SET ROLE remain visible, so both deleted writes and all authenticated
# truncation stay closed.
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; SELECT public.security_definer_insert(201, 'blocked-security-definer');" \
  'deleted-security-definer' \
  'authenticated account is not active'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$ACTIVE_USER\"}'; SELECT public.security_definer_truncate();" \
  'active-security-definer-truncate' \
  'authenticated relation truncation is forbidden'

# Modern and legacy suspension states are equally authoritative.
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$BANNED_USER\"}'; INSERT INTO public.mutation_probe VALUES (202, 'blocked-modern-ban');" \
  'modern-ban' \
  'authenticated account is not active'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$LEGACY_BANNED_USER\"}'; INSERT INTO public.mutation_probe VALUES (203, 'blocked-legacy-ban');" \
  'legacy-ban' \
  'authenticated account is not active'

# Missing, malformed, and contradictory authenticated claims fail closed. A
# valid legacy claim pair remains compatible.
expect_failure_matching \
  "SET ROLE authenticated; RESET request.jwt.claims; RESET request.jwt.claim.role; RESET request.jwt.claim.sub; INSERT INTO public.mutation_probe VALUES (204, 'missing-claims');" \
  'authenticated-missing-claims' \
  'authenticated mutation JWT identity is unavailable'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\"}'; INSERT INTO public.mutation_probe VALUES (205, 'missing-sub');" \
  'authenticated-missing-sub' \
  'authenticated mutation JWT identity is unavailable'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{malformed'; INSERT INTO public.mutation_probe VALUES (206, 'malformed');" \
  'authenticated-malformed-claims' \
  'authenticated mutation JWT claims are malformed'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"service_role\",\"sub\":\"$ACTIVE_USER\"}'; INSERT INTO public.mutation_probe VALUES (207, 'role-confusion');" \
  'authenticated-role-confusion' \
  'authenticated mutation JWT identity is unavailable'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"not-a-uuid\"}'; INSERT INTO public.mutation_probe VALUES (208, 'bad-sub');" \
  'authenticated-malformed-subject' \
  'authenticated mutation JWT subject is malformed'
psql_cmd -c "SET ROLE authenticated; SET request.jwt.claims = ''; SET request.jwt.claim.role = 'authenticated'; SET request.jwt.claim.sub = '$ACTIVE_USER'; INSERT INTO public.mutation_probe VALUES (109, 'legacy-claims');" >/dev/null

# The alphabetically-first BEFORE STATEMENT guard rejects before a later
# statement trigger can run.
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; INSERT INTO public.ordered_probe VALUES (1);" \
  'statement-trigger-order' \
  'authenticated account is not active'
if rg -q 'late statement trigger executed' "$LOG_DIR/statement-trigger-order.log"; then
  echo 'A row/statement side effect ran before inactive-subject admission' >&2
  exit 1
fi

# Existing partition parents and leaves are each protected when named directly.
psql_cmd -c "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$ACTIVE_USER\"}'; INSERT INTO public.partition_probe VALUES (10, 'parent-active'); INSERT INTO public.partition_probe_low VALUES (11, 'leaf-active');" >/dev/null
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; INSERT INTO public.partition_probe VALUES (12, 'parent-deleted');" \
  'deleted-partition-parent' \
  'authenticated account is not active'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; INSERT INTO public.partition_probe_low VALUES (13, 'leaf-deleted');" \
  'deleted-partition-leaf' \
  'authenticated account is not active'

# Future migrations install and assert coverage in their own transaction. This
# is the runtime counterpart to the repository test that enforces the convention.
psql_cmd <<'SQL'
CREATE TABLE public.future_probe (id integer PRIMARY KEY);
CREATE TABLE public.future_partition_probe (id integer NOT NULL)
  PARTITION BY RANGE (id);
CREATE TABLE public.future_partition_probe_low
  PARTITION OF public.future_partition_probe FOR VALUES FROM (0) TO (100);
CREATE TABLE storage.future_objects (id text PRIMARY KEY);
ALTER TABLE public.future_probe OWNER TO postgres;
ALTER TABLE public.future_partition_probe OWNER TO postgres;
ALTER TABLE public.future_partition_probe_low OWNER TO postgres;
ALTER TABLE storage.future_objects OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER
  ON public.future_probe,
     public.future_partition_probe,
     public.future_partition_probe_low,
     storage.future_objects
  TO authenticated, service_role;
SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();
DO $coverage$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgname =
        '000_active_authenticated_subject_statement_guard'
      AND trigger_row.tgrelid IN (
        'public.future_probe'::regclass,
        'public.future_partition_probe'::regclass,
        'public.future_partition_probe_low'::regclass,
        'storage.future_objects'::regclass
      )
      AND trigger_row.tgtype = 62
      AND trigger_row.tgenabled IN ('O', 'A')
  ) <> 4 THEN
    RAISE EXCEPTION 'future relation or partition coverage is incomplete';
  END IF;
  IF pg_catalog.has_table_privilege(
      'authenticated',
      'public.future_probe',
      'TRUNCATE'
    ) OR pg_catalog.has_table_privilege(
      'authenticated',
      'public.future_probe',
      'TRIGGER'
    ) THEN
    RAISE EXCEPTION 'future relation retained dangerous DDL privileges';
  END IF;
END
$coverage$;
SQL
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; INSERT INTO public.future_probe VALUES (1);" \
  'deleted-future-table' \
  'authenticated account is not active'
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETED_USER\"}'; INSERT INTO public.future_partition_probe_low VALUES (1);" \
  'deleted-future-partition' \
  'authenticated account is not active'

# Deletion wins: its explicit lifecycle key is safely re-entered by the profile
# status trigger; a queued authenticated write observes the committed tombstone.
psql_cmd >"$LOG_DIR/delete-race-holder.log" 2>&1 <<SQL &
BEGIN;
SET ROLE service_role;
SET request.jwt.claims = '{"role":"service_role"}';
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:' || '$DELETE_RACE_USER'::uuid::text,
    0
  )
);
UPDATE public.user_profiles
SET deleted_at = pg_catalog.clock_timestamp()
WHERE id = '$DELETE_RACE_USER';
SELECT pg_catalog.pg_sleep(1);
COMMIT;
SQL
delete_holder_pid=$!
wait_for_subject_lock "$DELETE_RACE_USER"
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$DELETE_RACE_USER\"}'; INSERT INTO public.mutation_probe VALUES (300, 'queued-after-delete');" \
  'delete-wins-race' \
  'authenticated account is not active'
wait "$delete_holder_pid"

# Recovery wins: clearing the tombstone under the same key lets the queued write
# proceed after commit. Re-entering the key from the profile trigger must not
# deadlock the recovery transaction.
psql_cmd >"$LOG_DIR/recovery-race-holder.log" 2>&1 <<SQL &
BEGIN;
SET ROLE service_role;
SET request.jwt.claims = '{"role":"service_role"}';
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:' || '$RECOVERY_RACE_USER'::uuid::text,
    0
  )
);
UPDATE public.user_profiles
SET deleted_at = NULL
WHERE id = '$RECOVERY_RACE_USER';
SELECT pg_catalog.pg_sleep(1);
COMMIT;
SQL
recovery_holder_pid=$!
wait_for_subject_lock "$RECOVERY_RACE_USER"
psql_cmd -c "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$RECOVERY_RACE_USER\"}'; INSERT INTO public.mutation_probe VALUES (301, 'queued-after-recovery');" >/dev/null
wait "$recovery_holder_pid"

# Hard deletion uses the same ordering. A queued stale JWT waits, then rejects
# the now-missing subject instead of recreating state or deadlocking.
psql_cmd >"$LOG_DIR/hard-delete-race-holder.log" 2>&1 <<SQL &
BEGIN;
SET ROLE service_role;
SET request.jwt.claims = '{"role":"service_role"}';
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:' || '$HARD_DELETE_RACE_USER'::uuid::text,
    0
  )
);
DELETE FROM public.user_profiles WHERE id = '$HARD_DELETE_RACE_USER';
SELECT pg_catalog.pg_sleep(1);
COMMIT;
SQL
hard_delete_holder_pid=$!
wait_for_subject_lock "$HARD_DELETE_RACE_USER"
expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"$HARD_DELETE_RACE_USER\"}'; INSERT INTO public.mutation_probe VALUES (302, 'queued-after-hard-delete');" \
  'hard-delete-wins-race' \
  'authenticated account is not active'
wait "$hard_delete_holder_pid"

psql_cmd <<'SQL'
DO $final_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.mutation_probe WHERE id = 301
  ) OR EXISTS (
    SELECT 1 FROM public.mutation_probe WHERE id IN (200, 201, 202, 203, 300, 302)
  ) THEN
    RAISE EXCEPTION 'inactive-subject mutation outcomes drifted';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id IN (
      '66666666-6666-4666-8666-666666666666',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
  ) THEN
    RAISE EXCEPTION 'missing/deleted profile recreation bypassed the barrier';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = '77777777-7777-4777-8777-777777777777'
  ) THEN
    RAISE EXCEPTION 'trusted first-profile provisioning regressed';
  END IF;
END
$final_proof$;

SET ROLE service_role;
SET request.jwt.claims = '{"role":"service_role"}';
TRUNCATE public.truncate_probe;
SELECT public.assert_active_authenticated_subject_mutation_barriers();
SQL

echo 'inactive authenticated-subject mutation barrier pg17 proof passed'
