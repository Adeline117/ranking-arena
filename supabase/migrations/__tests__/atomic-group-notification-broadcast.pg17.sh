#!/usr/bin/env bash

# PostgreSQL 17 proof for atomic group notification broadcasts. It owns an
# isolated temporary cluster and never connects to an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729156000_atomic_group_notification_broadcast.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-group-notification-broadcast-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((56000 + ($$ % 2000)))
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
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_failure() {
  local sql=$1
  if psql_cmd -c "$sql" >"$TMP_ROOT/expected-failure.out" 2>&1; then
    echo "Expected SQL to fail: $sql" >&2
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
CREATE ROLE postgres SUPERUSER NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE rogue_role NOLOGIN;

CREATE SCHEMA auth;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb
      ->> 'role'
  )::text
$function$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member');

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  dm_permission text NOT NULL DEFAULT 'all'
    CHECK (dm_permission IN ('all', 'mutual', 'none')),
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  dissolved_at timestamptz
);
CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL,
  self_notify_muted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.blocked_users (
  blocker_id uuid NOT NULL,
  blocked_id uuid NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE public.user_follows (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  follower_id uuid NOT NULL,
  following_id uuid NOT NULL,
  UNIQUE (follower_id, following_id)
);
CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user1_id uuid NOT NULL,
  user2_id uuid NOT NULL,
  last_message_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  last_message_preview text,
  UNIQUE (user1_id, user2_id),
  CHECK (user1_id < user2_id)
);
CREATE TABLE public.direct_messages (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL,
  receiver_id uuid NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  deleted_at timestamptz
);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  link text,
  actor_id uuid,
  reference_id text,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT notifications_type_check CHECK (type IN ('system', 'message'))
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.groups OWNER TO postgres;
ALTER TABLE public.group_members OWNER TO postgres;
ALTER TABLE public.blocked_users OWNER TO postgres;
ALTER TABLE public.user_follows OWNER TO postgres;
ALTER TABLE public.conversations OWNER TO postgres;
ALTER TABLE public.direct_messages OWNER TO postgres;
ALTER TABLE public.notifications OWNER TO postgres;

CREATE FUNCTION public.check_dm_permission(
  p_sender_id uuid,
  p_receiver_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_permission text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.blocked_users AS edge
    WHERE (edge.blocker_id = p_sender_id AND edge.blocked_id = p_receiver_id)
       OR (edge.blocker_id = p_receiver_id AND edge.blocked_id = p_sender_id)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('allowed', false, 'reason', 'BLOCKED');
  END IF;
  SELECT profile.dm_permission
  INTO v_permission
  FROM public.user_profiles AS profile
  WHERE profile.id = p_receiver_id
    AND profile.deleted_at IS NULL
    AND profile.banned_at IS NULL;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'USER_NOT_FOUND'
    );
  END IF;
  IF v_permission <> 'all' THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'DM_DISABLED'
    );
  END IF;
  RETURN pg_catalog.jsonb_build_object('allowed', true);
END
$function$;
ALTER FUNCTION public.check_dm_permission(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.check_dm_permission(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_dm_permission(uuid, uuid)
  TO service_role;

CREATE FUNCTION public.send_direct_message_atomic(
  p_sender_id uuid,
  p_receiver_id uuid,
  p_content text,
  p_media_url text DEFAULT NULL,
  p_media_type text DEFAULT NULL,
  p_media_name text DEFAULT NULL,
  p_reply_to_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_pair text;
  v_permission jsonb;
  v_conversation_id uuid;
  v_message public.direct_messages%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  v_pair := LEAST(p_sender_id::text, p_receiver_id::text)
    || ':' || GREATEST(p_sender_id::text, p_receiver_id::text);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
  );
  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id IN (p_sender_id, p_receiver_id)
  ORDER BY profile.id
  FOR SHARE;
  v_permission := public.check_dm_permission(p_sender_id, p_receiver_id);
  IF (v_permission ->> 'allowed')::boolean IS NOT TRUE THEN
    RETURN v_permission || pg_catalog.jsonb_build_object('success', false);
  END IF;
  INSERT INTO public.conversations(user1_id, user2_id)
  VALUES (LEAST(p_sender_id, p_receiver_id), GREATEST(p_sender_id, p_receiver_id))
  ON CONFLICT (user1_id, user2_id) DO UPDATE
    SET user1_id = EXCLUDED.user1_id
  RETURNING id INTO v_conversation_id;
  INSERT INTO public.direct_messages (
    conversation_id, sender_id, receiver_id, content
  ) VALUES (
    v_conversation_id, p_sender_id, p_receiver_id, p_content
  ) RETURNING * INTO v_message;
  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'allowed', true,
    'message', pg_catalog.to_jsonb(v_message),
    'conversation_id', v_conversation_id
  );
END
$function$;
ALTER FUNCTION public.send_direct_message_atomic(
  uuid, uuid, text, text, text, text, uuid
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.send_direct_message_atomic(
  uuid, uuid, text, text, text, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.send_direct_message_atomic(
  uuid, uuid, text, text, text, text, uuid
) TO service_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SELECT public.broadcast_group_notification_atomic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001',NULL,'hello',NULL)"
expect_failure "SET ROLE rogue_role; SELECT public.broadcast_group_notification_atomic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001',NULL,'hello',NULL)"
expect_failure "SET ROLE service_role; SELECT public.broadcast_group_notification_atomic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001',NULL,'hello',NULL)"

psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444'),
  ('55555555-5555-4555-8555-555555555555'),
  ('66666666-6666-4666-8666-666666666666'),
  ('77777777-7777-4777-8777-777777777777'),
  ('88888888-8888-4888-8888-888888888888'),
  ('99999999-9999-4999-8999-999999999999');
INSERT INTO public.user_profiles(id, dm_permission, deleted_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'all', NULL),
  ('22222222-2222-4222-8222-222222222222', 'all', NULL),
  ('33333333-3333-4333-8333-333333333333', 'all', NULL),
  ('44444444-4444-4444-8444-444444444444', 'none', NULL),
  ('55555555-5555-4555-8555-555555555555', 'all', NULL),
  ('66666666-6666-4666-8666-666666666666', 'all', NULL),
  ('77777777-7777-4777-8777-777777777777', 'all', pg_catalog.clock_timestamp()),
  ('88888888-8888-4888-8888-888888888888', 'all', NULL),
  ('99999999-9999-4999-8999-999999999999', 'all', NULL);
INSERT INTO public.groups(id, name) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Atomic Group'),
  ('10000000-0000-4000-8000-000000000002', 'Admin Group');
INSERT INTO public.group_members(group_id, user_id, role, self_notify_muted) VALUES
  ('10000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'owner', false),
  ('10000000-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'member', false),
  ('10000000-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'member', false),
  ('10000000-0000-4000-8000-000000000001', '55555555-5555-4555-8555-555555555555', 'member', false),
  ('10000000-0000-4000-8000-000000000001', '66666666-6666-4666-8666-666666666666', 'member', true),
  ('10000000-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777', 'member', false),
  ('10000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'owner', false),
  ('10000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'admin', false),
  ('10000000-0000-4000-8000-000000000002', '88888888-8888-4888-8888-888888888888', 'member', false);
INSERT INTO public.blocked_users(blocker_id, blocked_id) VALUES
  ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111');

SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

DO $behavior_contract$
DECLARE
  v_result jsonb;
  v_replay jsonb;
BEGIN
  v_result := public.broadcast_group_notification_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    '10000000-0000-4000-8000-000000000001',
    '  Café update  ',
    '  Hello members  ',
    NULL
  );
  IF v_result->>'success' <> 'true'
     OR v_result->>'applied' <> 'true'
     OR v_result->>'notified' <> '3'
     OR v_result->>'dm_delivered' <> '1'
     OR v_result->>'dm_skipped' <> '2'
     OR v_result->'dm_skip_reasons'->>'BLOCKED' <> '1'
     OR v_result->'dm_skip_reasons'->>'DM_DISABLED' <> '1'
  THEN
    RAISE EXCEPTION 'broadcast behavior drifted: %', v_result;
  END IF;

  IF (SELECT pg_catalog.count(*) FROM public.notifications
      WHERE type = 'system') <> 3
     OR (SELECT pg_catalog.count(*) FROM public.direct_messages) <> 1
     OR EXISTS (
       SELECT 1 FROM public.notifications
       WHERE user_id IN (
         '66666666-6666-4666-8666-666666666666',
         '77777777-7777-4777-8777-777777777777'
       )
     )
  THEN
    RAISE EXCEPTION 'recipient privacy/eligibility drifted';
  END IF;

  v_replay := public.broadcast_group_notification_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    '10000000-0000-4000-8000-000000000001',
    'Café update',
    'Hello members',
    NULL
  );
  IF v_replay->>'success' <> 'true'
     OR v_replay->>'applied' <> 'false'
     OR (SELECT pg_catalog.count(*) FROM public.notifications
         WHERE type = 'system') <> 3
     OR (SELECT pg_catalog.count(*) FROM public.direct_messages) <> 1
  THEN
    RAISE EXCEPTION 'broadcast replay duplicated effects: %', v_replay;
  END IF;

  IF public.broadcast_group_notification_atomic(
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       '11111111-1111-4111-8111-111111111111',
       '10000000-0000-4000-8000-000000000001',
       'Café update',
       'different payload',
       NULL
     )->>'reason' <> 'OPERATION_CONFLICT'
     OR public.broadcast_group_notification_atomic(
       'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
       '33333333-3333-4333-8333-333333333333',
       '10000000-0000-4000-8000-000000000001',
       NULL,
       'unauthorized',
       ARRAY['11111111-1111-4111-8111-111111111111']::uuid[]
     )->>'reason' <> 'PERMISSION_DENIED'
  THEN
    RAISE EXCEPTION 'broadcast conflict/validation drifted';
  END IF;

  v_result := public.broadcast_group_notification_atomic(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc',
    '22222222-2222-4222-8222-222222222222',
    '10000000-0000-4000-8000-000000000002',
    NULL,
    'admin message',
    ARRAY['88888888-8888-4888-8888-888888888888']::uuid[]
  );
  IF v_result->>'success' <> 'true' OR v_result->>'notified' <> '1' THEN
    RAISE EXCEPTION 'admin broadcast failed: %', v_result;
  END IF;
END
$behavior_contract$;
SQL

# A committed admin demotion must win over a broadcast that discovered its
# recipient while the role update was in flight.
PGAPPNAME=atomic-group-notify-demotion psql_cmd <<'SQL' >"$TMP_ROOT/demotion.out" 2>&1 &
BEGIN;
UPDATE public.group_members
SET role = 'member'
WHERE group_id = '10000000-0000-4000-8000-000000000002'
  AND user_id = '22222222-2222-4222-8222-222222222222';
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
demotion_pid=$!

race_ready=false
for _ in {1..80}; do
  if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = 'atomic-group-notify-demotion' AND state = 'active' AND wait_event = 'PgSleep'")" == "1" ]]; then
    race_ready=true
    break
  fi
  sleep 0.025
done
if [[ "$race_ready" != true ]]; then
  echo 'Concurrent notification demotion did not reach its proof barrier' >&2
  wait "$demotion_pid" || true
  exit 1
fi

demotion_result="$(psql_cmd -Atqc "SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.broadcast_group_notification_atomic('cccccccc-cccc-4ccc-8ccc-cccccccccccc','22222222-2222-4222-8222-222222222222','10000000-0000-4000-8000-000000000002',NULL,'must deny',ARRAY['88888888-8888-4888-8888-888888888888']::uuid[])->>'reason'")"
wait "$demotion_pid"
if [[ "${demotion_result##*$'\n'}" != 'PERMISSION_DENIED' ]]; then
  echo "Concurrent manager demotion still broadcast: $demotion_result" >&2
  exit 1
fi

# A member removal owns the row first. The broadcast waits, then revalidates
# the missing member and emits no notification or DM.
psql_cmd -qc "INSERT INTO public.group_members(group_id,user_id,role) VALUES ('10000000-0000-4000-8000-000000000001','99999999-9999-4999-8999-999999999999','member')"
PGAPPNAME=atomic-group-notify-removal psql_cmd <<'SQL' >"$TMP_ROOT/removal.out" 2>&1 &
BEGIN;
DELETE FROM public.group_members
WHERE group_id = '10000000-0000-4000-8000-000000000001'
  AND user_id = '99999999-9999-4999-8999-999999999999';
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
removal_pid=$!

race_ready=false
for _ in {1..80}; do
  if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = 'atomic-group-notify-removal' AND state = 'active' AND wait_event = 'PgSleep'")" == "1" ]]; then
    race_ready=true
    break
  fi
  sleep 0.025
done
if [[ "$race_ready" != true ]]; then
  echo 'Concurrent member removal did not reach its proof barrier' >&2
  wait "$removal_pid" || true
  exit 1
fi

removal_result="$(psql_cmd -Atqc "SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.broadcast_group_notification_atomic('dddddddd-dddd-4ddd-8ddd-dddddddddddd','11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001',NULL,'must skip removed',ARRAY['99999999-9999-4999-8999-999999999999']::uuid[])->>'reason'")"
wait "$removal_pid"
if [[ "${removal_result##*$'\n'}" != 'NO_RECIPIENTS' ]]; then
  echo "Concurrent removed member was notified: $removal_result" >&2
  exit 1
fi

# Inject a failure on the second system notification. The earlier canonical DM,
# first notification row and replay ledger row must all roll back.
psql_cmd <<'SQL'
CREATE FUNCTION public.fail_second_group_system_notification()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.type = 'system'
     AND NEW.user_id = '44444444-4444-4444-8444-444444444444'
  THEN
    RAISE EXCEPTION 'injected second notification failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER fail_second_group_system_notification
BEFORE INSERT ON public.notifications
FOR EACH ROW EXECUTE FUNCTION public.fail_second_group_system_notification();

CREATE TEMP TABLE before_failure_counts AS
SELECT
  (SELECT pg_catalog.count(*) FROM public.direct_messages) AS messages,
  (SELECT pg_catalog.count(*) FROM public.notifications) AS notifications,
  (SELECT pg_catalog.count(*)
   FROM public.group_notification_broadcast_operations) AS operations;
SQL

before_counts="$(psql_cmd -Atqc "SELECT (SELECT count(*) FROM public.direct_messages) || ':' || (SELECT count(*) FROM public.notifications) || ':' || (SELECT count(*) FROM public.group_notification_broadcast_operations)")"
expect_failure "SET ROLE service_role; SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.broadcast_group_notification_atomic('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','fault','roll back',ARRAY['33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444']::uuid[])"
after_counts="$(psql_cmd -Atqc "SELECT (SELECT count(*) FROM public.direct_messages) || ':' || (SELECT count(*) FROM public.notifications) || ':' || (SELECT count(*) FROM public.group_notification_broadcast_operations)")"
if [[ "$before_counts" != "$after_counts" ]]; then
  echo "Injected failure left partial broadcast effects: $before_counts -> $after_counts" >&2
  exit 1
fi

psql_cmd -qc "DROP TRIGGER fail_second_group_system_notification ON public.notifications; DROP FUNCTION public.fail_second_group_system_notification()"

echo 'atomic group notification broadcast PG17 proof passed'
