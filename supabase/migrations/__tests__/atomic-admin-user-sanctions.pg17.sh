#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MUTATION_BARRIER="$ROOT_DIR/supabase/migrations/20260729154500_inactive_auth_subject_mutation_barrier.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729157500_atomic_admin_user_sanctions.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-admin-user-sanctions-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55675
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

expect_eq() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

expect_failure_matching() {
  local sql="$1"
  local label="$2"
  local pattern="$3"
  local failure_log="$LOG_DIR/$label.log"
  if psql_cmd -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "Expected failure: $label" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$failure_log"; then
    echo "Failure did not match $pattern: $label" >&2
    cat "$failure_log" >&2
    exit 1
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
    sleep 0.02
  done
  echo "Timed out waiting for lifecycle lock: $user_id" >&2
  exit 1
}

ACTOR_A='11111111-1111-4111-8111-111111111111'
ACTOR_B='22222222-2222-4222-8222-222222222222'
TARGET='33333333-3333-4333-8333-333333333333'
LEGACY_TARGET='44444444-4444-4444-8444-444444444444'
DELETED_TARGET='55555555-5555-4555-8555-555555555555'
BANNED_ACTOR='66666666-6666-4666-8666-666666666666'
FAILURE_TARGET='77777777-7777-4777-8777-777777777777'
INVERTED_TARGET='88888888-8888-4888-8888-888888888888'
MISSING_TARGET='99999999-9999-4999-8999-999999999999'
DELETION_RACE_TARGET='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

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
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.sub', true),
    ''
  )::uuid
$function$;

CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    ''
  )
$function$;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text
);

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle text NOT NULL,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz,
  banned_reason text,
  banned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE TABLE public.admin_logs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action text NOT NULL,
  target_type text,
  target_id uuid,
  details jsonb,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE auth.users OWNER TO postgres;
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.admin_logs OWNER TO postgres;

GRANT USAGE ON SCHEMA auth, public, storage
  TO anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role()
  TO anon, authenticated, authenticator, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER
  ON ALL TABLES IN SCHEMA public
  TO authenticated, service_role;

INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'actor-a@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'actor-b@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'target@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'legacy@example.com'),
  ('55555555-5555-4555-8555-555555555555', 'deleted@example.com'),
  ('66666666-6666-4666-8666-666666666666', 'banned-actor@example.com'),
  ('77777777-7777-4777-8777-777777777777', 'failure@example.com'),
  ('88888888-8888-4888-8888-888888888888', 'inverted@example.com'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'delete-race@example.com');

INSERT INTO public.user_profiles (
  id,
  handle,
  deleted_at,
  banned_at,
  is_banned,
  ban_expires_at,
  banned_reason
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'actor-a', NULL, NULL, false, NULL, NULL),
  ('22222222-2222-4222-8222-222222222222', 'actor-b', NULL, NULL, false, NULL, NULL),
  ('33333333-3333-4333-8333-333333333333', 'target', NULL, NULL, false, NULL, NULL),
  ('44444444-4444-4444-8444-444444444444', 'legacy-target', NULL, NULL, true, NULL, 'legacy'),
  ('55555555-5555-4555-8555-555555555555', 'deleted-target', '2026-07-29', NULL, false, NULL, NULL),
  ('66666666-6666-4666-8666-666666666666', 'banned-actor', NULL, '2026-07-29', true, NULL, 'banned'),
  ('77777777-7777-4777-8777-777777777777', 'failure-target', NULL, NULL, false, NULL, NULL),
  ('88888888-8888-4888-8888-888888888888', 'inverted-target', NULL, NULL, false, NULL, NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'deletion-race-target', NULL, NULL, false, NULL, NULL);
SQL

psql_cmd -q -f "$MUTATION_BARRIER"
psql_cmd -q -f "$MIGRATION"

service_query() {
  local sql="$1"
  psql_cmd -qAtF '|' -c "
    SET ROLE service_role;
    SET request.jwt.claim.role = 'service_role';
    $sql
  "
}

# The canonical ban writes both representations and its audit atomically.
expect_eq "$(service_query "SELECT * FROM public.set_admin_user_sanction_atomic('$ACTOR_A', '$TARGET', 'ban', ' abuse ')")" \
  "t|ban|applied|$TARGET|target" \
  'canonical ban acknowledgement'
expect_eq "$(psql_cmd -qAtF '|' -c "
  SELECT
    (banned_at IS NOT NULL)::text,
    is_banned::text,
    ban_expires_at IS NULL,
    banned_reason,
    banned_by
  FROM public.user_profiles
  WHERE id = '$TARGET'
")" \
  "true|true|t|abuse|$ACTOR_A" \
  'canonical ban profile state'
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.admin_logs WHERE action = 'ban_user' AND target_id = '$TARGET'")" \
  '1' \
  'canonical ban audit count'

# Replays are typed no-ops and do not duplicate the audit trail.
expect_eq "$(service_query "SELECT * FROM public.set_admin_user_sanction_atomic('$ACTOR_A', '$TARGET', 'ban', 'different')")" \
  "f|ban|already_banned|$TARGET|target" \
  'repeat ban status'
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.admin_logs WHERE action = 'ban_user' AND target_id = '$TARGET'")" \
  '1' \
  'repeat ban audit count'

# Unban clears current and legacy state together.
expect_eq "$(service_query "SELECT * FROM public.set_admin_user_sanction_atomic('$ACTOR_A', '$TARGET', 'unban', NULL)")" \
  "t|unban|applied|$TARGET|target" \
  'canonical unban acknowledgement'
expect_eq "$(psql_cmd -qAtF '|' -c "
  SELECT
    banned_at IS NULL,
    NOT is_banned,
    ban_expires_at IS NULL,
    banned_reason IS NULL,
    banned_by IS NULL
  FROM public.user_profiles
  WHERE id = '$TARGET'
")" \
  't|t|t|t|t' \
  'canonical unban profile state'

# The old endpoint could not see this legacy-only permanent ban.  The atomic
# unban repairs every marker and restores account admission.
expect_eq "$(service_query "SELECT * FROM public.set_admin_user_sanction_atomic('$ACTOR_A', '$LEGACY_TARGET', 'unban', NULL)")" \
  "t|unban|applied|$LEGACY_TARGET|legacy-target" \
  'legacy-only unban acknowledgement'
expect_eq "$(psql_cmd -Atqc "SELECT (banned_at IS NULL AND NOT is_banned AND ban_expires_at IS NULL AND banned_reason IS NULL AND banned_by IS NULL)::text FROM public.user_profiles WHERE id = '$LEGACY_TARGET'")" \
  'true' \
  'legacy-only unban state'

expect_eq "$(service_query "SELECT * FROM public.set_admin_user_sanction_atomic('$ACTOR_A', '$DELETED_TARGET', 'ban', NULL)")" \
  "f|ban|target_deleted|$DELETED_TARGET|deleted-target" \
  'deleted target status'
expect_eq "$(service_query "SELECT * FROM public.set_admin_user_sanction_atomic('$ACTOR_A', '$MISSING_TARGET', 'ban', NULL)")" \
  "f|ban|not_found|$MISSING_TARGET|" \
  'missing target status'

expect_failure_matching \
  "SET ROLE authenticated; SET request.jwt.claim.role = 'authenticated'; SELECT * FROM public.set_admin_user_sanction_atomic('$ACTOR_A', '$TARGET', 'ban', NULL);" \
  'authenticated-acl' \
  'permission denied for function set_admin_user_sanction_atomic'
expect_failure_matching \
  "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; SELECT * FROM public.set_admin_user_sanction_atomic('$ACTOR_A', '$ACTOR_A', 'ban', NULL);" \
  'self-sanction' \
  '22023|invalid administrator user sanction input'
expect_failure_matching \
  "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; SELECT * FROM public.set_admin_user_sanction_atomic('$BANNED_ACTOR', '$TARGET', 'ban', NULL);" \
  'suspended-actor' \
  '42501|active administrator identity required'

# Existing report/service writers that name only one representation are
# normalized by the lifecycle trigger until they can be migrated to the RPC.
service_query "
  UPDATE public.user_profiles
  SET banned_at = pg_catalog.clock_timestamp(),
      is_banned = false,
      banned_reason = 'modern-only writer'
  WHERE id = '$FAILURE_TARGET'
" >/dev/null
expect_eq "$(psql_cmd -Atqc "SELECT (banned_at IS NOT NULL AND is_banned)::text FROM public.user_profiles WHERE id = '$FAILURE_TARGET'")" \
  'true' \
  'modern-only writer normalization'
service_query "UPDATE public.user_profiles SET banned_at = NULL WHERE id = '$FAILURE_TARGET'" >/dev/null
expect_eq "$(psql_cmd -Atqc "SELECT (banned_at IS NULL AND NOT is_banned AND ban_expires_at IS NULL AND banned_reason IS NULL AND banned_by IS NULL)::text FROM public.user_profiles WHERE id = '$FAILURE_TARGET'")" \
  'true' \
  'modern-only unban normalization'
service_query "
  UPDATE public.user_profiles
  SET is_banned = true,
      ban_expires_at = pg_catalog.clock_timestamp() + interval '1 day',
      banned_reason = 'legacy-only writer'
  WHERE id = '$FAILURE_TARGET'
" >/dev/null
expect_eq "$(psql_cmd -Atqc "SELECT (banned_at IS NOT NULL AND is_banned AND ban_expires_at IS NOT NULL)::text FROM public.user_profiles WHERE id = '$FAILURE_TARGET'")" \
  'true' \
  'legacy-only writer normalization'
service_query "UPDATE public.user_profiles SET banned_at = NULL WHERE id = '$FAILURE_TARGET'" >/dev/null

# Failure injection: an audit insert failure must roll back the preceding
# profile update.  There can never be a ban without its administrator record.
psql_cmd -q <<'SQL'
CREATE FUNCTION public.fail_admin_log_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'injected admin audit failure';
END
$function$;
CREATE TRIGGER zzz_fail_admin_log_insert
BEFORE INSERT ON public.admin_logs
FOR EACH ROW
EXECUTE FUNCTION public.fail_admin_log_insert();
SQL
expect_failure_matching \
  "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; SELECT * FROM public.set_admin_user_sanction_atomic('$ACTOR_A', '$FAILURE_TARGET', 'ban', 'must roll back');" \
  'audit-failure-injection' \
  'injected admin audit failure'
expect_eq "$(psql_cmd -Atqc "SELECT (banned_at IS NULL AND NOT is_banned AND ban_expires_at IS NULL AND banned_reason IS NULL AND banned_by IS NULL)::text FROM public.user_profiles WHERE id = '$FAILURE_TARGET'")" \
  'true' \
  'audit failure profile rollback'
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.admin_logs WHERE target_id = '$FAILURE_TARGET'")" \
  '0' \
  'audit failure log rollback'
psql_cmd -q -c 'DROP TRIGGER zzz_fail_admin_log_insert ON public.admin_logs; DROP FUNCTION public.fail_admin_log_insert();'

# A canonical lifecycle holder owns the advisory key before its row.  An old
# inverted writer that grabs the row next receives 40001 immediately; it does
# not deadlock the canonical operation.
psql_cmd >"$LOG_DIR/inverted-writer-holder.log" 2>&1 <<SQL &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:' || '$INVERTED_TARGET'::uuid::text,
    0
  )
);
SELECT pg_catalog.pg_sleep(1);
UPDATE public.user_profiles
SET deleted_at = pg_catalog.clock_timestamp()
WHERE id = '$INVERTED_TARGET';
COMMIT;
SQL
inverted_holder_pid=$!
wait_for_subject_lock "$INVERTED_TARGET"
expect_failure_matching \
  "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; UPDATE public.user_profiles SET banned_at = pg_catalog.clock_timestamp() WHERE id = '$INVERTED_TARGET';" \
  'inverted-writer-conflict' \
  '40001|account lifecycle transition conflicts with a canonical writer'
wait "$inverted_holder_pid"
expect_eq "$(psql_cmd -Atqc "SELECT (deleted_at IS NOT NULL AND banned_at IS NULL AND NOT is_banned)::text FROM public.user_profiles WHERE id = '$INVERTED_TARGET'")" \
  'true' \
  'inverted writer outcome'

# Deletion wins the shared lifecycle key.  A queued administrator ban sees the
# committed tombstone instead of overwriting it.
psql_cmd >"$LOG_DIR/deletion-race-holder.log" 2>&1 <<SQL &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:' || '$DELETION_RACE_TARGET'::uuid::text,
    0
  )
);
UPDATE public.user_profiles
SET deleted_at = pg_catalog.clock_timestamp()
WHERE id = '$DELETION_RACE_TARGET';
SELECT pg_catalog.pg_sleep(1);
COMMIT;
SQL
deletion_holder_pid=$!
wait_for_subject_lock "$DELETION_RACE_TARGET"
expect_eq "$(service_query "SELECT * FROM public.set_admin_user_sanction_atomic('$ACTOR_A', '$DELETION_RACE_TARGET', 'ban', NULL)")" \
  "f|ban|target_deleted|$DELETION_RACE_TARGET|deletion-race-target" \
  'deletion race status'
wait "$deletion_holder_pid"

# Opposing administrators request A -> B and B -> A concurrently.  UUID-sorted
# lifecycle/Auth/profile locks produce one committed sanction and one closed
# actor check, never a deadlock or two crossed bans.
psql_cmd -qAt >"$LOG_DIR/opposing-sanction-a.log" 2>&1 <<SQL &
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT status
FROM public.set_admin_user_sanction_atomic(
  '$ACTOR_A',
  '$ACTOR_B',
  'ban',
  'opposing A to B'
);
SQL
opposing_a_pid=$!
psql_cmd -qAt >"$LOG_DIR/opposing-sanction-b.log" 2>&1 <<SQL &
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT status
FROM public.set_admin_user_sanction_atomic(
  '$ACTOR_B',
  '$ACTOR_A',
  'ban',
  'opposing B to A'
);
SQL
opposing_b_pid=$!

set +e
wait "$opposing_a_pid"
opposing_a_status=$?
wait "$opposing_b_pid"
opposing_b_status=$?
set -e

if ! {
  ((opposing_a_status == 0 && opposing_b_status != 0)) ||
  ((opposing_a_status != 0 && opposing_b_status == 0))
}; then
  echo "Opposing sanction exit statuses drifted: A=$opposing_a_status B=$opposing_b_status" >&2
  cat "$LOG_DIR/opposing-sanction-a.log" >&2
  cat "$LOG_DIR/opposing-sanction-b.log" >&2
  exit 1
fi
if ! rg -q '^applied$' "$LOG_DIR/opposing-sanction-a.log" "$LOG_DIR/opposing-sanction-b.log"; then
  echo 'Neither opposing sanction committed' >&2
  exit 1
fi
if ! rg -q 'active administrator identity required' "$LOG_DIR/opposing-sanction-a.log" "$LOG_DIR/opposing-sanction-b.log"; then
  echo 'Opposing sanction loser did not close on suspended actor state' >&2
  exit 1
fi
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.user_profiles WHERE id IN ('$ACTOR_A', '$ACTOR_B') AND banned_at IS NOT NULL AND is_banned")" \
  '1' \
  'opposing sanction profile count'
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.admin_logs WHERE action = 'ban_user' AND target_id IN ('$ACTOR_A', '$ACTOR_B')")" \
  '1' \
  'opposing sanction audit count'

psql_cmd -q -c 'SELECT public.assert_active_authenticated_subject_mutation_barriers();' >/dev/null

echo 'atomic administrator user sanctions PG17 proof passed'
