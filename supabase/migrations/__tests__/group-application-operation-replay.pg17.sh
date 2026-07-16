#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ATOMIC_MIGRATION="$ROOT_DIR/supabase/migrations/20260716111600_atomic_group_application_review.sql"
ACL_MIGRATION="$ROOT_DIR/supabase/migrations/20260716111700_group_application_read_write_boundary.sql"
REPLAY_MIGRATION="$ROOT_DIR/supabase/migrations/20260716164000_group_application_operation_replay.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
for migration in "$ATOMIC_MIGRATION" "$ACL_MIGRATION" "$REPLAY_MIGRATION"; do
  if [[ ! -f "$migration" ]]; then
    echo "Group-application migration is missing: $migration" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/group-application-replay-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55464
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if (( exit_status != 0 )) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

"$PG_BIN/initdb" -D "$DATA_DIR" --auth-local=trust --auth-host=trust \
  --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

PSQL=("$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres)

wait_for_true() {
  local query="$1"
  local description="$2"
  local value
  for _attempt in {1..120}; do
    value="$("${PSQL[@]}" -Atqc "$query")"
    if [[ "$value" == "1" ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "Timed out waiting for $description" >&2
  return 1
}

"${PSQL[@]}" <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE hostile_role NOLOGIN;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;
CREATE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role, hostile_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO PUBLIC;

CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member');

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz,
  role text,
  subscription_tier text NOT NULL DEFAULT 'free',
  pro_expires_at timestamptz
);
CREATE TABLE public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tier text,
  plan text,
  status text NOT NULL,
  current_period_end timestamptz
);
CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  name_en text,
  description text,
  description_en text,
  avatar_url text,
  slug text,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_names jsonb,
  rules_json jsonb,
  rules text,
  is_premium_only boolean NOT NULL DEFAULT false,
  member_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX groups_name_lower_unique
  ON public.groups (lower(name)) WHERE name IS NOT NULL;
CREATE UNIQUE INDEX groups_slug_key
  ON public.groups (slug) WHERE slug IS NOT NULL;
CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.group_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  name_en text,
  description text,
  description_en text,
  avatar_url text,
  role_names jsonb,
  rules_json jsonb,
  rules text,
  is_premium_only boolean DEFAULT false,
  status text NOT NULL DEFAULT 'pending',
  reject_reason text,
  group_id uuid REFERENCES public.groups(id),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT clock_timestamp()
);
CREATE TABLE public.group_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES public.groups(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  details jsonb,
  created_at timestamptz DEFAULT clock_timestamp()
);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('system', 'message')),
  title text NOT NULL,
  message text NOT NULL,
  link text,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reference_id uuid,
  read boolean DEFAULT false,
  read_at timestamptz,
  created_at timestamptz DEFAULT clock_timestamp()
);

ALTER TABLE public.group_applications ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.group_applications TO anon, authenticated, service_role;
GRANT ALL ON public.user_profiles, public.subscriptions, public.groups,
  public.group_members, public.group_audit_log, public.notifications TO service_role;
CREATE POLICY legacy_all ON public.group_applications FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

INSERT INTO auth.users (id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444'),
  ('55555555-5555-4555-8555-555555555555'),
  ('66666666-6666-4666-8666-666666666666'),
  ('77777777-7777-4777-8777-777777777777'),
  ('88888888-8888-4888-8888-888888888888');
INSERT INTO public.user_profiles (id, role) VALUES
  ('11111111-1111-4111-8111-111111111111', 'member'),
  ('22222222-2222-4222-8222-222222222222', 'member'),
  ('33333333-3333-4333-8333-333333333333', 'admin'),
  ('44444444-4444-4444-8444-444444444444', 'admin'),
  ('55555555-5555-4555-8555-555555555555', 'member'),
  ('66666666-6666-4666-8666-666666666666', 'member'),
  ('77777777-7777-4777-8777-777777777777', 'member'),
  ('88888888-8888-4888-8888-888888888888', 'member');
SQL

"${PSQL[@]}" -f "$ATOMIC_MIGRATION" >/dev/null
"${PSQL[@]}" -f "$ACL_MIGRATION" >/dev/null
"${PSQL[@]}" -f "$REPLAY_MIGRATION" >/dev/null
"${PSQL[@]}" -f "$REPLAY_MIGRATION" >/dev/null

"${PSQL[@]}" <<'SQL'
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);

DO $test$
DECLARE
  first_result jsonb;
  replay_result jsonb;
  conflict_result jsonb;
BEGIN
  first_result := public.submit_group_application_atomic(
    '11111111-1111-4111-8111-111111111111',
    'Replay Group', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    false, false,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  replay_result := public.submit_group_application_atomic(
    '11111111-1111-4111-8111-111111111111',
    'Replay Group', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    false, false,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  conflict_result := public.submit_group_application_atomic(
    '11111111-1111-4111-8111-111111111111',
    'Changed Group', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    false, false,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );

  IF first_result->>'status' <> 'submitted'
    OR first_result->>'operation_id' <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    OR first_result->>'application_id' IS DISTINCT FROM replay_result->>'application_id'
    OR first_result->>'applied' <> 'true'
    OR replay_result->>'applied' <> 'false'
    OR conflict_result <> '{"status":"operation_conflict"}'::jsonb
  THEN
    RAISE EXCEPTION 'submit exact replay contract failed: %, %, %',
      first_result, replay_result, conflict_result;
  END IF;
  IF (SELECT count(*) FROM public.group_applications
      WHERE name = 'Replay Group') <> 1 THEN
    RAISE EXCEPTION 'submit replay duplicated durable state';
  END IF;
END
$test$;

INSERT INTO public.group_applications (id, applicant_id, name)
VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '55555555-5555-4555-8555-555555555555',
  'Approved Replay Group'
), (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '55555555-5555-4555-8555-555555555555',
  ''
), (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '55555555-5555-4555-8555-555555555555',
  repeat('😀', 80)
);

DO $test$
DECLARE
  first_result jsonb;
  replay_result jsonb;
  conflict_result jsonb;
BEGIN
  first_result := public.review_group_application_atomic(
    '33333333-3333-4333-8333-333333333333',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'approve', NULL, false,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  );
  replay_result := public.review_group_application_atomic(
    '33333333-3333-4333-8333-333333333333',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'approve', NULL, false,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  );
  conflict_result := public.review_group_application_atomic(
    '44444444-4444-4444-8444-444444444444',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'approve', NULL, false,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  );

  IF first_result->>'status' <> 'approved'
    OR first_result->>'group_id' IS DISTINCT FROM replay_result->>'group_id'
    OR first_result->>'applied' <> 'true'
    OR replay_result->>'applied' <> 'false'
    OR conflict_result <> '{"status":"operation_conflict"}'::jsonb
  THEN
    RAISE EXCEPTION 'approve exact replay contract failed: %, %, %',
      first_result, replay_result, conflict_result;
  END IF;
  IF (SELECT count(*) FROM public.groups
      WHERE id = (first_result->>'group_id')::uuid) <> 1
    OR (SELECT count(*) FROM public.group_members
        WHERE group_id = (first_result->>'group_id')::uuid AND role = 'owner') <> 1
    OR (SELECT count(*) FROM public.notifications
        WHERE reference_id = (first_result->>'group_id')::uuid) <> 1
  THEN
    RAISE EXCEPTION 'approve replay duplicated or omitted transaction state';
  END IF;
END
$test$;

DO $test$
DECLARE
  empty_result jsonb;
  emoji_result jsonb;
  long_reason text := repeat('😀', 500);
BEGIN
  empty_result := public.review_group_application_atomic(
    '33333333-3333-4333-8333-333333333333',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'reject', long_reason, false,
    'ffffffff-ffff-4fff-8fff-ffffffffffff'
  );
  emoji_result := public.review_group_application_atomic(
    '33333333-3333-4333-8333-333333333333',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'reject', NULL, false,
    '12121212-1212-4212-8212-121212121212'
  );
  IF empty_result->>'status' <> 'rejected'
    OR empty_result->>'group_name' <> 'Group'
    OR char_length(empty_result->>'reject_reason') <> 500
    OR emoji_result->>'status' <> 'rejected'
    OR char_length(emoji_result->>'group_name') <> 50
    OR EXISTS (
      SELECT 1 FROM public.notifications
      WHERE reference_id IN (
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      )
      AND char_length(message) > 500
    )
  THEN
    RAISE EXCEPTION 'Unicode-safe rejection result/notification failed: %, %',
      empty_result, emoji_result;
  END IF;
END
$test$;
RESET ROLE;

DO $acl$
BEGIN
  IF (SELECT count(*) FROM public.group_application_operation_results
      WHERE operation_id IN (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
        '12121212-1212-4212-8212-121212121212'
      )) <> 4 THEN
    RAISE EXCEPTION 'permanent operation results were not retained exactly once';
  END IF;
  IF has_table_privilege(
      'service_role',
      'public.group_application_operation_results',
      'SELECT,INSERT,UPDATE,DELETE'
    ) OR has_table_privilege(
      'authenticated',
      'public.group_application_operation_results',
      'SELECT,INSERT,UPDATE,DELETE'
    ) OR has_function_privilege(
      'authenticated',
      'public.review_group_application_atomic(uuid,uuid,text,text,boolean,uuid)',
      'EXECUTE'
    ) OR NOT has_function_privilege(
      'service_role',
      'public.review_group_application_atomic(uuid,uuid,text,text,boolean,uuid)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'exact operation ledger/RPC ACL failed';
  END IF;
END
$acl$;
SQL

# A notification failure must roll the review and ledger back together.
"${PSQL[@]}" <<'SQL'
CREATE FUNCTION public.fail_test_notification()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.reference_id = '34343434-3434-4434-8434-343434343434'::uuid THEN
    RAISE EXCEPTION 'forced notification failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER zz_fail_test_notification
BEFORE INSERT ON public.notifications
FOR EACH ROW EXECUTE FUNCTION public.fail_test_notification();
INSERT INTO public.group_applications (id, applicant_id, name)
VALUES (
  '34343434-3434-4434-8434-343434343434',
  '22222222-2222-4222-8222-222222222222',
  'Rollback rejection'
);
SQL
if "${PSQL[@]}" <<'SQL' >"$LOG_DIR/rollback.out" 2>&1
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.review_group_application_atomic(
  '33333333-3333-4333-8333-333333333333',
  '34343434-3434-4434-8434-343434343434',
  'reject', NULL, false,
  '56565656-5656-4656-8656-565656565656'
);
SQL
then
  echo "Forced notification failure unexpectedly committed" >&2
  exit 1
fi
"${PSQL[@]}" <<'SQL'
DO $rollback$
BEGIN
  IF (SELECT status FROM public.group_applications
      WHERE id = '34343434-3434-4434-8434-343434343434') <> 'pending'
    OR EXISTS (
      SELECT 1 FROM public.group_application_operation_results
      WHERE operation_id = '56565656-5656-4656-8656-565656565656'
    )
  THEN
    RAISE EXCEPTION 'notification failure left partial review state';
  END IF;
END
$rollback$;
DROP TRIGGER zz_fail_test_notification ON public.notifications;
DROP FUNCTION public.fail_test_notification();
SQL

# Force two identical submit calls to overlap behind the same operation lock.
"${PSQL[@]}" <<'SQL'
CREATE FUNCTION public.pause_test_submission()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.name = 'Concurrent replay' THEN
    PERFORM pg_catalog.pg_sleep(1);
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER zz_pause_test_submission
BEFORE INSERT ON public.group_applications
FOR EACH ROW EXECUTE FUNCTION public.pause_test_submission();
SQL

for attempt in 1 2; do
  "${PSQL[@]}" -At <<'SQL' >"$LOG_DIR/concurrent-$attempt.out" 2>&1 &
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.submit_group_application_atomic(
  '55555555-5555-4555-8555-555555555555',
  'Concurrent replay', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  false, false,
  '78787878-7878-4878-8878-787878787878'
);
SQL
done
wait

if [[ "$(grep -h -c '"applied": true' "$LOG_DIR"/concurrent-*.out | awk '{s += $1} END {print s + 0}')" != "1" ]] \
  || [[ "$(grep -h -c '"applied": false' "$LOG_DIR"/concurrent-*.out | awk '{s += $1} END {print s + 0}')" != "1" ]]; then
  echo "Concurrent exact retries did not split into one apply and one replay" >&2
  cat "$LOG_DIR"/concurrent-*.out >&2
  exit 1
fi
"${PSQL[@]}" <<'SQL'
DO $concurrency$
BEGIN
  IF (SELECT count(*) FROM public.group_applications
      WHERE name = 'Concurrent replay') <> 1
    OR (SELECT count(*) FROM public.group_application_operation_results
        WHERE operation_id = '78787878-7878-4878-8878-787878787878') <> 1
  THEN
    RAISE EXCEPTION 'concurrent exact retry duplicated state';
  END IF;
END
$concurrency$;
SQL

# If a later dependency is busy, a failed NOWAIT attempt must release every
# earlier DDL lock. A third runtime call must therefore complete through the
# ledger/auth/application path while notifications remains blocked.
PGAPPNAME=group_application_partial_blocker "${PSQL[@]}" \
  >"$LOG_DIR/partial-blocker.out" 2>&1 <<'SQL' &
BEGIN;
LOCK TABLE public.notifications IN ROW EXCLUSIVE MODE;
SELECT pg_catalog.pg_sleep(3);
COMMIT;
SQL
partial_blocker_pid=$!
wait_for_true "
  SELECT (EXISTS (
    SELECT 1
    FROM pg_catalog.pg_locks AS lock_row
    JOIN pg_catalog.pg_stat_activity AS activity
      ON activity.pid = lock_row.pid
    WHERE activity.application_name = 'group_application_partial_blocker'
      AND lock_row.relation = 'public.notifications'::pg_catalog.regclass
      AND lock_row.mode = 'RowExclusiveLock'
      AND lock_row.granted
  ))::integer
" "the late dependency blocker"

PGAPPNAME=group_application_partial_ddl "${PSQL[@]}" -f "$REPLAY_MIGRATION" \
  >"$LOG_DIR/partial-ddl.out" 2>&1 &
partial_ddl_pid=$!
wait_for_true "
  SELECT (EXISTS (
    SELECT 1
    FROM pg_catalog.pg_stat_activity AS activity
    WHERE activity.application_name = 'group_application_partial_ddl'
      AND activity.wait_event = 'PgSleep'
  ))::integer
" "the DDL retry after a partial lock attempt"

if ! PGAPPNAME=group_application_partial_runtime "${PSQL[@]}" \
  >"$LOG_DIR/partial-runtime.out" 2>&1 <<'SQL'
SET statement_timeout = '1500ms';
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.submit_group_application_atomic(
  '66666666-6666-4666-8666-666666666666',
  'Partial release proof', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  false, false,
  '67676767-6767-4767-8767-676767676767'
);
SQL
then
  echo "A failed complete-lock attempt retained an early relation lock" >&2
  cat "$LOG_DIR/partial-runtime.out" "$LOG_DIR/partial-ddl.out" >&2
  exit 1
fi
if ! kill -0 "$partial_blocker_pid" 2>/dev/null; then
  echo "Partial release proof did not finish before the late blocker" >&2
  exit 1
fi
wait "$partial_blocker_pid"
wait "$partial_ddl_pid"
if ! grep -q '"applied": true' "$LOG_DIR/partial-runtime.out"; then
  echo "Partial release runtime did not commit its operation" >&2
  cat "$LOG_DIR/partial-runtime.out" >&2
  exit 1
fi

# Runtime-first: hold the promoted submit function after it has taken the
# ledger-first barrier. Migration replay must retry without deadlocking and then
# complete after the runtime commits.
"${PSQL[@]}" <<'SQL'
CREATE OR REPLACE FUNCTION public.pause_test_submission()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.name = 'Runtime first barrier' THEN
    PERFORM pg_catalog.pg_sleep(2);
  END IF;
  RETURN NEW;
END
$function$;
SQL
PGAPPNAME=group_application_runtime_first "${PSQL[@]}" \
  >"$LOG_DIR/runtime-first.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.submit_group_application_atomic(
  '77777777-7777-4777-8777-777777777777',
  'Runtime first barrier', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  false, false,
  '79797979-7979-4979-8979-797979797979'
);
SQL
runtime_first_pid=$!
wait_for_true "
  SELECT (EXISTS (
    SELECT 1
    FROM pg_catalog.pg_locks AS lock_row
    JOIN pg_catalog.pg_stat_activity AS activity
      ON activity.pid = lock_row.pid
    WHERE activity.application_name = 'group_application_runtime_first'
      AND lock_row.relation =
        'public.group_application_operation_results'::pg_catalog.regclass
      AND lock_row.mode = 'RowExclusiveLock'
      AND lock_row.granted
  ))::integer
" "the runtime-first ledger barrier"

PGAPPNAME=group_application_runtime_first_ddl "${PSQL[@]}" -f "$REPLAY_MIGRATION" \
  >"$LOG_DIR/runtime-first-ddl.out" 2>&1 &
runtime_first_ddl_pid=$!
wait_for_true "
  SELECT (EXISTS (
    SELECT 1
    FROM pg_catalog.pg_stat_activity AS activity
    WHERE activity.application_name = 'group_application_runtime_first_ddl'
      AND activity.wait_event = 'PgSleep'
  ))::integer
" "the runtime-first DDL retry"
wait "$runtime_first_pid"
wait "$runtime_first_ddl_pid"
if ! grep -q '"applied": true' "$LOG_DIR/runtime-first.out"; then
  echo "Runtime-first operation did not commit" >&2
  cat "$LOG_DIR/runtime-first.out" "$LOG_DIR/runtime-first-ddl.out" >&2
  exit 1
fi

# DDL-first: an event trigger pauses replay only after the complete lock set has
# succeeded. Review must wait on the ledger and must not acquire child locks
# before the migration commits.
"${PSQL[@]}" <<'SQL'
INSERT INTO public.group_applications (id, applicant_id, name)
VALUES (
  '89898989-8989-4989-8989-898989898989',
  '88888888-8888-4888-8888-888888888888',
  'DDL first review'
);
CREATE FUNCTION public.pause_test_group_application_ddl()
RETURNS event_trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF pg_catalog.current_setting(
      'group_application.test_ddl_pause',
      true
    ) = 'on' AND TG_TAG = 'ALTER TABLE'
  THEN
    PERFORM pg_catalog.pg_sleep(0.7);
  END IF;
END
$function$;
CREATE EVENT TRIGGER pause_test_group_application_ddl
ON ddl_command_start
EXECUTE FUNCTION public.pause_test_group_application_ddl();
SQL
PGOPTIONS='-c group_application.test_ddl_pause=on' \
PGAPPNAME=group_application_ddl_first "${PSQL[@]}" -f "$REPLAY_MIGRATION" \
  >"$LOG_DIR/ddl-first.out" 2>&1 &
ddl_first_pid=$!
wait_for_true "
  SELECT (EXISTS (
    SELECT 1
    FROM pg_catalog.pg_locks AS lock_row
    JOIN pg_catalog.pg_stat_activity AS activity
      ON activity.pid = lock_row.pid
    WHERE activity.application_name = 'group_application_ddl_first'
      AND lock_row.relation =
        'public.group_application_operation_results'::pg_catalog.regclass
      AND lock_row.mode = 'AccessExclusiveLock'
      AND lock_row.granted
  ))::integer
" "the DDL-first ledger barrier"

PGAPPNAME=group_application_ddl_first_runtime "${PSQL[@]}" \
  >"$LOG_DIR/ddl-first-runtime.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.review_group_application_atomic(
  '33333333-3333-4333-8333-333333333333',
  '89898989-8989-4989-8989-898989898989',
  'reject', NULL, false,
  '90909090-9090-4090-8090-909090909090'
);
SQL
ddl_first_runtime_pid=$!
wait_for_true "
  SELECT (EXISTS (
    SELECT 1
    FROM pg_catalog.pg_locks AS lock_row
    JOIN pg_catalog.pg_stat_activity AS activity
      ON activity.pid = lock_row.pid
    WHERE activity.application_name = 'group_application_ddl_first_runtime'
      AND lock_row.relation =
        'public.group_application_operation_results'::pg_catalog.regclass
      AND lock_row.mode = 'RowExclusiveLock'
      AND NOT lock_row.granted
  ))::integer
" "the DDL-first runtime ledger wait"
if [[ "$("${PSQL[@]}" -Atqc "
  SELECT (EXISTS (
    SELECT 1
    FROM pg_catalog.pg_locks AS lock_row
    JOIN pg_catalog.pg_stat_activity AS activity
      ON activity.pid = lock_row.pid
    WHERE activity.application_name = 'group_application_ddl_first_runtime'
      AND lock_row.granted
      AND lock_row.relation IN (
        'auth.users'::pg_catalog.regclass,
        'public.user_profiles'::pg_catalog.regclass,
        'public.group_applications'::pg_catalog.regclass
      )
  ))::integer
")" != "0" ]]; then
  echo "DDL-first runtime acquired a child relation before the ledger barrier" >&2
  exit 1
fi
wait "$ddl_first_pid"
wait "$ddl_first_runtime_pid"
if ! grep -q '"status": "rejected"' "$LOG_DIR/ddl-first-runtime.out" \
  || ! grep -q '"applied": true' "$LOG_DIR/ddl-first-runtime.out"; then
  echo "DDL-first runtime did not resume and commit" >&2
  cat "$LOG_DIR/ddl-first.out" "$LOG_DIR/ddl-first-runtime.out" >&2
  exit 1
fi
"${PSQL[@]}" <<'SQL'
DROP EVENT TRIGGER pause_test_group_application_ddl;
DROP FUNCTION public.pause_test_group_application_ddl();
SQL

# Two replaying migration sessions serialize through the migration advisory
# lock and both attest the same final catalog without deadlock.
replay_pids=()
for attempt in 1 2; do
  PGAPPNAME="group_application_replay_race_$attempt" \
    "${PSQL[@]}" -f "$REPLAY_MIGRATION" \
    >"$LOG_DIR/replay-race-$attempt.out" 2>&1 &
  replay_pids+=("$!")
done
for replay_pid in "${replay_pids[@]}"; do
  if ! wait "$replay_pid"; then
    echo "Concurrent migration replay failed" >&2
    cat "$LOG_DIR"/replay-race-*.out >&2
    exit 1
  fi
done
if grep -Eqi 'deadlock|lock timeout|could not acquire' "$LOG_DIR"/replay-race-*.out; then
  echo "Concurrent migration replay reported a lock failure" >&2
  cat "$LOG_DIR"/replay-race-*.out >&2
  exit 1
fi

# The replay preflight must detect source tampering before replacing it.
"${PSQL[@]}" <<'SQL'
CREATE OR REPLACE FUNCTION public.review_group_application_atomic(
  p_reviewer_id uuid,
  p_application_id uuid,
  p_decision text,
  p_reject_reason text DEFAULT NULL,
  p_promo_unlocked boolean DEFAULT false,
  p_operation_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s'
AS $function$
BEGIN
  RETURN '{"status":"tampered"}'::jsonb;
END
$function$;
SQL
if "${PSQL[@]}" -f "$REPLAY_MIGRATION" >"$LOG_DIR/tamper.out" 2>&1; then
  echo "Migration replay accepted a tampered RPC source" >&2
  exit 1
fi
if ! grep -q 'source seal drifted' "$LOG_DIR/tamper.out"; then
  echo "Migration replay failed for an unexpected tamper reason" >&2
  cat "$LOG_DIR/tamper.out" >&2
  exit 1
fi

echo "Group-application operation replay PG17 integration proof passed"
