#!/usr/bin/env bash

# PostgreSQL 17 proof for atomic group-channel creation. It owns an isolated
# temporary cluster and never connects to an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716161000_atomic_group_channel_create.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "PostgreSQL 17 is required" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/atomic-group-channel-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((57000 + ($$ % 5000)))
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

expect_migration_failure() {
  if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/expected-migration-failure.out" 2>&1; then
    echo "Expected migration replay to reject catalog drift" >&2
    return 1
  fi
}

expect_activity_wait() {
  local application_name=$1
  local wait_event_type=$2
  local wait_event=${3:-}
  local attempt
  local event_predicate=''

  if [[ -n "$wait_event" ]]; then
    event_predicate="AND wait_event = '$wait_event'"
  fi

  for attempt in {1..80}; do
    if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = '$application_name' AND wait_event_type = '$wait_event_type' $event_predicate")" == "1" ]]; then
      return 0
    fi
    sleep 0.1
  done

  echo "Timed out waiting for $application_name ($wait_event_type ${wait_event:-any})" >&2
  return 1
}

service_call_sql() {
  local channel_id=$1
  local actor_id=$2
  local name=$3
  local description=$4
  local candidates=$5
  printf "SET ROLE service_role; SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.create_group_channel_atomic('%s','%s','%s',%s,ARRAY[%s]::uuid[])" \
    "$channel_id" "$actor_id" "$name" "$description" "$candidates"
}

add_call_sql() {
  local channel_id=$1
  local actor_id=$2
  local candidates=$3
  printf "SET ROLE service_role; SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.add_channel_members_atomic('%s','%s',ARRAY[%s]::uuid[])" \
    "$channel_id" "$actor_id" "$candidates"
}

dissolve_call_sql() {
  local channel_id=$1
  local actor_id=$2
  printf "SET ROLE service_role; SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.dissolve_group_channel_atomic('%s','%s')" \
    "$channel_id" "$actor_id"
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

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);

CREATE TABLE public.conversations (
  id uuid PRIMARY KEY
);

CREATE TABLE public.chat_channels (
  id uuid PRIMARY KEY,
  name text,
  type text NOT NULL CHECK (type IN ('direct', 'group')),
  created_by uuid,
  avatar_url text,
  description text,
  conversation_id uuid REFERENCES public.conversations(id),
  last_message_at timestamptz,
  last_message_preview text,
  created_at timestamptz,
  updated_at timestamptz
);

CREATE TABLE public.channel_members (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL
    REFERENCES public.chat_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  nickname text,
  is_muted boolean,
  is_pinned boolean,
  cleared_before timestamptz,
  joined_at timestamptz,
  UNIQUE (channel_id, user_id)
);

CREATE TABLE public.channel_message_reads (
  channel_id uuid NOT NULL
    REFERENCES public.chat_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  last_read_at timestamptz,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE public.channel_messages (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL
    REFERENCES public.chat_channels(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL,
  content text NOT NULL
);

-- Reproduce the production 20260715060000 Auth FK trigger order: personal
-- channel state cascades first, while created_by SET NULL is the final channel
-- edge reached by an Auth hard deletion.
ALTER TABLE public.channel_members
  ADD CONSTRAINT channel_members_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.channel_message_reads
  ADD CONSTRAINT channel_message_reads_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.channel_messages
  ADD CONSTRAINT channel_messages_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.chat_channels
  ADD CONSTRAINT chat_channels_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  dm_permission text,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean,
  ban_expires_at timestamptz
);

CREATE TABLE public.blocked_users (
  blocker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE public.user_follows (
  follower_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  following_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (follower_id, following_id)
);

CREATE TABLE public.notifications (
  user_id uuid NOT NULL,
  type text NOT NULL,
  actor_id uuid NOT NULL
);

CREATE TABLE public.user_activities (
  user_id uuid NOT NULL,
  activity_type text NOT NULL,
  target_id uuid NOT NULL
);

ALTER TABLE public.conversations OWNER TO postgres;
ALTER TABLE public.chat_channels OWNER TO postgres;
ALTER TABLE public.channel_members OWNER TO postgres;
ALTER TABLE public.channel_message_reads OWNER TO postgres;
ALTER TABLE public.channel_messages OWNER TO postgres;
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.blocked_users OWNER TO postgres;
ALTER TABLE public.user_follows OWNER TO postgres;

ALTER TABLE public.chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chat_channels, public.channel_members
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.chat_channels, public.channel_members
  TO service_role;
CREATE POLICY "Service role manages chat channels"
  ON public.chat_channels
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY "Service role manages channel members"
  ON public.channel_members
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE FUNCTION public.serialize_direct_message_pair_edge()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_pairs text[] := ARRAY[]::text[];
  v_pair text;
  v_old_left uuid;
  v_old_right uuid;
  v_new_left uuid;
  v_new_right uuid;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'blocked_users' THEN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_old_left := OLD.blocker_id;
        v_old_right := OLD.blocked_id;
      END IF;
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_new_left := NEW.blocker_id;
        v_new_right := NEW.blocked_id;
      END IF;
    WHEN 'user_follows' THEN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_old_left := OLD.follower_id;
        v_old_right := OLD.following_id;
      END IF;
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_new_left := NEW.follower_id;
        v_new_right := NEW.following_id;
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported pair table';
  END CASE;

  IF v_old_left IS NOT NULL AND v_old_right IS NOT NULL THEN
    v_pairs := pg_catalog.array_append(
      v_pairs,
      LEAST(v_old_left::text, v_old_right::text)
        || ':' || GREATEST(v_old_left::text, v_old_right::text)
    );
  END IF;
  IF v_new_left IS NOT NULL AND v_new_right IS NOT NULL THEN
    v_pairs := pg_catalog.array_append(
      v_pairs,
      LEAST(v_new_left::text, v_new_right::text)
        || ':' || GREATEST(v_new_left::text, v_new_right::text)
    );
  END IF;

  FOR v_pair IN
    SELECT DISTINCT affected_pair
    FROM pg_catalog.unnest(v_pairs) AS affected(affected_pair)
    ORDER BY affected_pair
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
    );
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.serialize_direct_message_pair_edge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.serialize_direct_message_pair_edge()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.serialize_post_audience_block_edge()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_pair text;
BEGIN
  v_pair := LEAST(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.blocker_id ELSE NEW.blocker_id END::text,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.blocked_id ELSE NEW.blocked_id END::text
  ) || ':' || GREATEST(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.blocker_id ELSE NEW.blocker_id END::text,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.blocked_id ELSE NEW.blocked_id END::text
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-audience:block:' || v_pair, 0)
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.serialize_post_audience_block_edge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.serialize_post_audience_block_edge()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_serialize_dm_block_pair
BEFORE INSERT OR DELETE OR UPDATE OF blocker_id, blocked_id
ON public.blocked_users
FOR EACH ROW
EXECUTE FUNCTION public.serialize_direct_message_pair_edge();
CREATE TRIGGER trg_serialize_post_audience_block_edge
BEFORE INSERT OR DELETE OR UPDATE OF blocker_id, blocked_id
ON public.blocked_users
FOR EACH ROW
EXECUTE FUNCTION public.serialize_post_audience_block_edge();
CREATE TRIGGER trg_serialize_dm_follow_pair
BEFORE INSERT OR DELETE OR UPDATE OF follower_id, following_id
ON public.user_follows
FOR EACH ROW
EXECUTE FUNCTION public.serialize_direct_message_pair_edge();

-- These independent production AFTER INSERT side effects coexist with the
-- serializer. The migration must preserve their exact trigger contracts.
CREATE FUNCTION public.create_user_follow_notification()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  following_notify_follow boolean := true;
BEGIN
  IF following_notify_follow THEN
    INSERT INTO notifications(user_id, type, actor_id)
    VALUES (NEW.following_id, 'follow', NEW.follower_id);
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.create_user_follow_notification() OWNER TO postgres;

CREATE FUNCTION public.log_user_follow_activity()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  INSERT INTO user_activities(user_id, activity_type, target_id)
  VALUES (NEW.follower_id, 'follow_user', NEW.following_id);
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.log_user_follow_activity() OWNER TO postgres;

CREATE TRIGGER on_user_follow
AFTER INSERT ON public.user_follows
FOR EACH ROW
EXECUTE FUNCTION public.create_user_follow_notification();

CREATE TRIGGER trg_log_user_follow_activity
AFTER INSERT ON public.user_follows
FOR EACH ROW
EXECUTE FUNCTION public.log_user_follow_activity();

CREATE FUNCTION public.add_channel_members_atomic(
  p_channel_id uuid,
  p_actor_id uuid,
  p_candidate_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'channel-membership:channel:' || p_channel_id::text,
      0
    )
  );
  IF p_channel_id::text = pg_catalog.current_setting(
    'test.pause_member_add_channel',
    true
  ) THEN
    PERFORM pg_catalog.pg_sleep(3);
  END IF;
  PERFORM pg_catalog.hashtextextended('direct-message:pair:', 0);
  RETURN pg_catalog.jsonb_build_object('success', false);
END
$function$;
ALTER FUNCTION public.add_channel_members_atomic(uuid, uuid, uuid[]) OWNER TO postgres;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.add_channel_members_atomic(uuid, uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE
  ON FUNCTION public.add_channel_members_atomic(uuid, uuid, uuid[])
  TO service_role;
DO $comment$
DECLARE
  v_function regprocedure :=
    'public.add_channel_members_atomic(uuid,uuid,uuid[])'::regprocedure;
  v_source text;
BEGIN
  SELECT function_row.prosrc INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;
  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-existing-channel-member-add:v1:' || pg_catalog.md5(v_source)
  );
END
$comment$;

-- Legacy rows intentionally precede 161000 so the migration must converge
-- both ownerless and multi-owner history while its ACCESS EXCLUSIVE lock is
-- held. The fourth channel proves empty direct channels remain valid.
INSERT INTO auth.users(id) VALUES
  ('90000000-0000-4000-8000-000000000001'),
  ('90000000-0000-4000-8000-000000000002'),
  ('90000000-0000-4000-8000-000000000003'),
  ('90000000-0000-4000-8000-000000000004');
INSERT INTO public.chat_channels(id, type, created_by) VALUES
  (
    '09000000-0000-4000-8000-000000000001',
    'group',
    '90000000-0000-4000-8000-000000000001'
  ),
  (
    '09000000-0000-4000-8000-000000000002',
    'group',
    '90000000-0000-4000-8000-000000000002'
  ),
  (
    '09000000-0000-4000-8000-000000000003',
    'group',
    '90000000-0000-4000-8000-000000000004'
  ),
  (
    '09000000-0000-4000-8000-000000000004',
    'direct',
    '90000000-0000-4000-8000-000000000001'
  );
INSERT INTO public.channel_members(id, channel_id, user_id, role) VALUES
  (
    '09100000-0000-4000-8000-000000000001',
    '09000000-0000-4000-8000-000000000002',
    '90000000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    '09100000-0000-4000-8000-000000000002',
    '09000000-0000-4000-8000-000000000002',
    '90000000-0000-4000-8000-000000000002',
    'owner'
  ),
  (
    '09100000-0000-4000-8000-000000000003',
    '09000000-0000-4000-8000-000000000003',
    '90000000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    '09100000-0000-4000-8000-000000000004',
    '09000000-0000-4000-8000-000000000003',
    '90000000-0000-4000-8000-000000000003',
    'owner'
  );
SQL

# Fresh install, then converge a drifted body/ACL on replay.
psql_cmd -f "$MIGRATION" >/dev/null

if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.has_table_privilege('service_role','public.chat_channels','DELETE')")" != "f" ]]; then
  echo "Fresh migration retained direct service-role channel deletion" >&2
  exit 1
fi

if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='09000000-0000-4000-8000-000000000001'")" != "0" ]]; then
  echo "Historical ownerless group survived repair" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.string_agg(user_id::text || ':' || role, ',' ORDER BY user_id) FROM public.channel_members WHERE channel_id='09000000-0000-4000-8000-000000000002'")" != "90000000-0000-4000-8000-000000000001:admin,90000000-0000-4000-8000-000000000002:owner" ]]; then
  echo "Historical multi-owner creator preference did not converge" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.string_agg(user_id::text || ':' || role, ',' ORDER BY user_id) FROM public.channel_members WHERE channel_id='09000000-0000-4000-8000-000000000003'")" != "90000000-0000-4000-8000-000000000001:owner,90000000-0000-4000-8000-000000000003:admin" ]]; then
  echo "Historical multi-owner UUID fallback did not converge" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='09000000-0000-4000-8000-000000000004' AND type='direct'")" != "1" ]]; then
  echo "Historical empty direct channel was incorrectly removed" >&2
  exit 1
fi
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.create_group_channel_atomic(
  p_channel_id uuid,
  p_actor_id uuid,
  p_name text,
  p_description text,
  p_candidate_ids uuid[]
)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT '{}'::jsonb
$function$;
GRANT EXECUTE
  ON FUNCTION public.create_group_channel_atomic(uuid, uuid, text, text, uuid[])
  TO authenticated;
GRANT DELETE ON TABLE public.chat_channels TO service_role;
SQL
psql_cmd -f "$MIGRATION" >/dev/null

if [[ "$(psql_cmd -Atqc "SELECT language_row.lanname = 'plpgsql' AND function_row.prosecdef AND pg_catalog.has_function_privilege('service_role', function_row.oid, 'EXECUTE') AND NOT pg_catalog.has_function_privilege('authenticated', function_row.oid, 'EXECUTE') FROM pg_catalog.pg_proc AS function_row JOIN pg_catalog.pg_language AS language_row ON language_row.oid=function_row.prolang WHERE function_row.oid='public.create_group_channel_atomic(uuid,uuid,text,text,uuid[])'::regprocedure")" != "t" ]]; then
  echo "Replay did not converge the function body/ACL" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT language_row.lanname = 'plpgsql' AND function_row.prosecdef AND pg_catalog.has_function_privilege('service_role', function_row.oid, 'EXECUTE') AND NOT pg_catalog.has_function_privilege('authenticated', function_row.oid, 'EXECUTE') FROM pg_catalog.pg_proc AS function_row JOIN pg_catalog.pg_language AS language_row ON language_row.oid=function_row.prolang WHERE function_row.oid='public.dissolve_group_channel_atomic(uuid,uuid)'::regprocedure")" != "t" ]]; then
  echo "Replay did not converge the dissolve function body/ACL" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.has_table_privilege('service_role','public.chat_channels','DELETE')")" != "f" ]]; then
  echo "Replay did not reconverge direct service-role channel deletion" >&2
  exit 1
fi
expect_failure "SET ROLE service_role; DELETE FROM public.chat_channels WHERE id='09000000-0000-4000-8000-000000000004'"
grep -q 'permission denied for table chat_channels' \
  "$TMP_ROOT/expected-failure.out"

# After create has been published, replay must reject even a self-hash-certified
# v1 add tag; only this migration's v2 lock contract is a valid replay input.
psql_cmd <<'SQL'
DO $retag$
DECLARE
  v_function regprocedure :=
    'public.add_channel_members_atomic(uuid,uuid,uuid[])'::regprocedure;
  v_source text;
BEGIN
  SELECT function_row.prosrc INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;
  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-existing-channel-member-add:v1:' || pg_catalog.md5(v_source)
  );
END
$retag$;
SQL
expect_migration_failure
grep -q 'certified existing-channel member-add v2 is required on replay' \
  "$TMP_ROOT/expected-migration-failure.out"
psql_cmd <<'SQL'
DO $retag$
DECLARE
  v_function regprocedure :=
    'public.add_channel_members_atomic(uuid,uuid,uuid[])'::regprocedure;
  v_source text;
BEGIN
  SELECT function_row.prosrc INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;
  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-existing-channel-member-add:v2:' || pg_catalog.md5(v_source)
  );
END
$retag$;
SQL

# Replay must reject relation, overload and trigger authority drift.
psql_cmd -c "ALTER TABLE public.chat_channels ADD COLUMN rogue text" >/dev/null
expect_migration_failure
psql_cmd -c "ALTER TABLE public.chat_channels DROP COLUMN rogue" >/dev/null

psql_cmd -c "CREATE FUNCTION public.create_group_channel_atomic(text) RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb'" >/dev/null
expect_migration_failure
psql_cmd -c "DROP FUNCTION public.create_group_channel_atomic(text)" >/dev/null

psql_cmd -c "CREATE FUNCTION public.dissolve_group_channel_atomic(text) RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb'" >/dev/null
expect_migration_failure
psql_cmd -c "DROP FUNCTION public.dissolve_group_channel_atomic(text)" >/dev/null

psql_cmd <<'SQL'
CREATE FUNCTION public.rogue_channel_trigger()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RETURN NEW;
END
$function$;
CREATE TRIGGER rogue_channel_trigger
BEFORE INSERT ON public.chat_channels
FOR EACH ROW EXECUTE FUNCTION public.rogue_channel_trigger();
SQL
expect_migration_failure
psql_cmd -c "DROP TRIGGER rogue_channel_trigger ON public.chat_channels; DROP FUNCTION public.rogue_channel_trigger()" >/dev/null

# The production follow notification/activity triggers are accepted only with
# their exact enabled event/function shapes, and no fourth trigger is allowed.
psql_cmd -c \
  "ALTER TABLE public.user_follows DISABLE TRIGGER on_user_follow" >/dev/null
expect_migration_failure
psql_cmd -c \
  "ALTER TABLE public.user_follows ENABLE TRIGGER on_user_follow" >/dev/null

psql_cmd <<'SQL'
DROP TRIGGER trg_log_user_follow_activity ON public.user_follows;
CREATE TRIGGER trg_log_user_follow_activity
AFTER INSERT ON public.user_follows
FOR EACH ROW
EXECUTE FUNCTION public.create_user_follow_notification();
SQL
expect_migration_failure
psql_cmd <<'SQL'
DROP TRIGGER trg_log_user_follow_activity ON public.user_follows;
CREATE TRIGGER trg_log_user_follow_activity
AFTER INSERT ON public.user_follows
FOR EACH ROW
EXECUTE FUNCTION public.log_user_follow_activity();
SQL

psql_cmd <<'SQL'
CREATE FUNCTION public.rogue_follow_side_effect()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEW;
END
$function$;
CREATE TRIGGER zz_rogue_follow_side_effect
AFTER INSERT ON public.user_follows
FOR EACH ROW
EXECUTE FUNCTION public.rogue_follow_side_effect();
SQL
expect_migration_failure
psql_cmd <<'SQL'
DROP TRIGGER zz_rogue_follow_side_effect ON public.user_follows;
DROP FUNCTION public.rogue_follow_side_effect();
SQL

psql_cmd -Atqc "SELECT pg_catalog.pg_get_functiondef('public.create_user_follow_notification()'::regprocedure)" >"$TMP_ROOT/follow-notification-function.sql"
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.create_user_follow_notification()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  RETURN NEW;
END
$function$;
SQL
expect_migration_failure
psql_cmd -f "$TMP_ROOT/follow-notification-function.sql" >/dev/null

psql_cmd -f "$MIGRATION" >/dev/null

# The parent constraint rejects a directly inserted empty group at commit, but
# does not impose group roster semantics on an empty direct channel.
expect_failure "SET ROLE service_role; INSERT INTO public.chat_channels(id,type,created_by) VALUES ('09000000-0000-4000-8000-000000000005','group','90000000-0000-4000-8000-000000000001')"
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='09000000-0000-4000-8000-000000000005'")" != "0" ]]; then
  echo "Failed empty-group insert did not roll back" >&2
  exit 1
fi
psql_cmd -c "SET ROLE service_role; INSERT INTO public.chat_channels(id,type,created_by) VALUES ('09000000-0000-4000-8000-000000000006','direct','90000000-0000-4000-8000-000000000001')" >/dev/null
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='09000000-0000-4000-8000-000000000006' AND type='direct'")" != "1" ]]; then
  echo "Empty direct insert was incorrectly rejected" >&2
  exit 1
fi

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
  ('a0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000002'),
  ('b0000000-0000-4000-8000-000000000002'),
  ('a0000000-0000-4000-8000-000000000003'),
  ('b0000000-0000-4000-8000-000000000003'),
  ('a0000000-0000-4000-8000-000000000004'),
  ('b0000000-0000-4000-8000-000000000004'),
  ('a0000000-0000-4000-8000-000000000005'),
  ('b0000000-0000-4000-8000-000000000005'),
  ('a0000000-0000-4000-8000-000000000006'),
  ('b0000000-0000-4000-8000-000000000006');

INSERT INTO public.user_profiles(
  id, dm_permission, deleted_at, banned_at, is_banned, ban_expires_at
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'all', NULL, NULL, false, NULL),
  ('22222222-2222-4222-8222-222222222222', 'all', NULL, NULL, false, NULL),
  ('33333333-3333-4333-8333-333333333333', 'mutual', NULL, NULL, false, NULL),
  ('44444444-4444-4444-8444-444444444444', 'none', NULL, NULL, false, NULL),
  (
    '55555555-5555-4555-8555-555555555555',
    'all', clock_timestamp(), NULL, false, NULL
  ),
  (
    '66666666-6666-4666-8666-666666666666',
    'all', NULL, NULL, true, NULL
  ),
  ('77777777-7777-4777-8777-777777777777', 'all', NULL, NULL, false, NULL),
  ('88888888-8888-4888-8888-888888888888', 'all', NULL, NULL, false, NULL),
  ('a0000000-0000-4000-8000-000000000001', 'all', NULL, NULL, false, NULL),
  ('b0000000-0000-4000-8000-000000000001', 'all', NULL, NULL, false, NULL),
  ('a0000000-0000-4000-8000-000000000002', 'all', NULL, NULL, false, NULL),
  ('b0000000-0000-4000-8000-000000000002', 'all', NULL, NULL, false, NULL),
  ('a0000000-0000-4000-8000-000000000003', 'all', NULL, NULL, false, NULL),
  ('b0000000-0000-4000-8000-000000000003', 'all', NULL, NULL, false, NULL),
  ('a0000000-0000-4000-8000-000000000004', 'all', NULL, NULL, false, NULL),
  ('b0000000-0000-4000-8000-000000000004', 'all', NULL, NULL, false, NULL),
  ('a0000000-0000-4000-8000-000000000005', 'all', NULL, NULL, false, NULL),
  ('b0000000-0000-4000-8000-000000000005', 'all', NULL, NULL, false, NULL),
  ('a0000000-0000-4000-8000-000000000006', 'all', NULL, NULL, false, NULL),
  ('b0000000-0000-4000-8000-000000000006', 'all', NULL, NULL, false, NULL);

INSERT INTO public.user_follows(follower_id, following_id) VALUES
  ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'),
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111');
SQL

# Base contract, exact replay, mismatched replay, unavailable/privacy cases,
# and candidate-to-candidate block enforcement.
psql_cmd <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $test$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.create_group_channel_atomic(
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'Base group',
    'base',
    ARRAY['22222222-2222-4222-8222-222222222222']::uuid[]
  );
  IF v_result ->> 'success' <> 'true'
     OR (v_result ->> 'member_count')::integer <> 2
     OR v_result -> 'members' <> '[
       {"role":"owner","user_id":"11111111-1111-4111-8111-111111111111"},
       {"role":"member","user_id":"22222222-2222-4222-8222-222222222222"}
     ]'::jsonb
  THEN
    RAISE EXCEPTION 'base group acknowledgement failed: %', v_result;
  END IF;

  v_result := public.create_group_channel_atomic(
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'Base group',
    'base',
    ARRAY['22222222-2222-4222-8222-222222222222']::uuid[]
  );
  IF v_result ->> 'success' <> 'true' THEN
    RAISE EXCEPTION 'exact idempotent replay failed: %', v_result;
  END IF;

  v_result := public.create_group_channel_atomic(
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'Changed group',
    'base',
    ARRAY['22222222-2222-4222-8222-222222222222']::uuid[]
  );
  IF v_result ->> 'reason' <> 'CHANNEL_ID_CONFLICT' THEN
    RAISE EXCEPTION 'mismatched replay was accepted: %', v_result;
  END IF;

  v_result := public.create_group_channel_atomic(
    '10000000-0000-4000-8000-000000000002',
    '55555555-5555-4555-8555-555555555555',
    'Inactive actor', NULL,
    ARRAY['22222222-2222-4222-8222-222222222222']::uuid[]
  );
  IF v_result ->> 'reason' <> 'ACTOR_UNAVAILABLE' THEN
    RAISE EXCEPTION 'inactive actor was accepted: %', v_result;
  END IF;

  v_result := public.create_group_channel_atomic(
    '10000000-0000-4000-8000-000000000003',
    '11111111-1111-4111-8111-111111111111',
    'Missing candidate', NULL,
    ARRAY['99999999-9999-4999-8999-999999999999']::uuid[]
  );
  IF v_result ->> 'reason' <> 'CANDIDATE_UNAVAILABLE' THEN
    RAISE EXCEPTION 'missing candidate was accepted: %', v_result;
  END IF;

  v_result := public.create_group_channel_atomic(
    '10000000-0000-4000-8000-000000000004',
    '11111111-1111-4111-8111-111111111111',
    'Private candidate', NULL,
    ARRAY['44444444-4444-4444-8444-444444444444']::uuid[]
  );
  IF v_result ->> 'reason' <> 'PRIVACY_DENIED' THEN
    RAISE EXCEPTION 'none permission was accepted: %', v_result;
  END IF;

  v_result := public.create_group_channel_atomic(
    '10000000-0000-4000-8000-000000000005',
    '11111111-1111-4111-8111-111111111111',
    'Mutual group', NULL,
    ARRAY['33333333-3333-4333-8333-333333333333']::uuid[]
  );
  IF v_result ->> 'success' <> 'true' THEN
    RAISE EXCEPTION 'mutual candidate was rejected: %', v_result;
  END IF;
END
$test$;

INSERT INTO public.blocked_users(blocker_id, blocked_id) VALUES
  ('22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333');
DO $test$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.create_group_channel_atomic(
    '10000000-0000-4000-8000-000000000006',
    '11111111-1111-4111-8111-111111111111',
    'Blocked co-members', NULL,
    ARRAY[
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333'
    ]::uuid[]
  );
  IF v_result ->> 'reason' <> 'PRIVACY_DENIED' THEN
    RAISE EXCEPTION 'candidate-to-candidate block was ignored: %', v_result;
  END IF;
END
$test$;
DELETE FROM public.blocked_users
WHERE blocker_id = '22222222-2222-4222-8222-222222222222'
  AND blocked_id = '33333333-3333-4333-8333-333333333333';
SQL

# Atomic dissolution revalidates the locked owner, deletes exactly once and
# treats a missing resource as a safe response-loss retry.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000040' '11111111-1111-4111-8111-111111111111' 'Dissolve base' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >/dev/null
psql_cmd -Atqc \
  "$(dissolve_call_sql '10000000-0000-4000-8000-000000000040' '22222222-2222-4222-8222-222222222222')" \
  >"$TMP_ROOT/dissolve-non-owner.out"
grep -q 'PERMISSION_DENIED' "$TMP_ROOT/dissolve-non-owner.out"
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000040'")" != "1" ]]; then
  echo "Non-owner dissolution removed the channel" >&2
  exit 1
fi
psql_cmd -Atqc \
  "$(dissolve_call_sql '10000000-0000-4000-8000-000000000040' '11111111-1111-4111-8111-111111111111')" \
  >"$TMP_ROOT/dissolve-applied.out"
grep -q '"applied": true' "$TMP_ROOT/dissolve-applied.out"
grep -q '"deleted": 1' "$TMP_ROOT/dissolve-applied.out"
psql_cmd -Atqc \
  "$(dissolve_call_sql '10000000-0000-4000-8000-000000000040' '11111111-1111-4111-8111-111111111111')" \
  >"$TMP_ROOT/dissolve-replay.out"
grep -q '"applied": false' "$TMP_ROOT/dissolve-replay.out"
grep -q '"deleted": 0' "$TMP_ROOT/dissolve-replay.out"
psql_cmd -Atqc \
  "$(dissolve_call_sql '10000000-0000-4000-8000-000000000041' '22222222-2222-4222-8222-222222222222')" \
  >"$TMP_ROOT/dissolve-missing.out"
grep -q '"applied": false' "$TMP_ROOT/dissolve-missing.out"
psql_cmd -Atqc \
  "$(dissolve_call_sql '09000000-0000-4000-8000-000000000006' '90000000-0000-4000-8000-000000000001')" \
  >"$TMP_ROOT/dissolve-direct.out"
grep -q 'CHANNEL_NOT_GROUP' "$TMP_ROOT/dissolve-direct.out"

# Raw function inputs are strict and the function is executable only by the
# service role. These failures must happen before a channel write.
expect_failure "SET ROLE authenticated; SELECT public.create_group_channel_atomic('10000000-0000-4000-8000-000000000010','11111111-1111-4111-8111-111111111111','Denied',NULL,ARRAY['22222222-2222-4222-8222-222222222222']::uuid[])"
expect_failure "SET ROLE rogue_role; SELECT public.create_group_channel_atomic('10000000-0000-4000-8000-000000000010','11111111-1111-4111-8111-111111111111','Denied',NULL,ARRAY['22222222-2222-4222-8222-222222222222']::uuid[])"
expect_failure "SET ROLE authenticated; SELECT public.dissolve_group_channel_atomic('10000000-0000-4000-8000-000000000040','11111111-1111-4111-8111-111111111111')"
expect_failure "SET ROLE rogue_role; SELECT public.dissolve_group_channel_atomic('10000000-0000-4000-8000-000000000040','11111111-1111-4111-8111-111111111111')"
expect_failure "SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.create_group_channel_atomic('10000000-0000-4000-8000-000000000010','11111111-1111-4111-8111-111111111111','Duplicate',NULL,ARRAY['22222222-2222-4222-8222-222222222222','22222222-2222-4222-8222-222222222222']::uuid[])"
expect_failure "SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.create_group_channel_atomic('10000000-0000-4000-8000-000000000010','11111111-1111-4111-8111-111111111111','Actor duplicate',NULL,ARRAY['11111111-1111-4111-8111-111111111111']::uuid[])"

# A member INSERT failure rolls back the preceding channel INSERT completely.
psql_cmd <<'SQL'
CREATE FUNCTION public.fail_selected_channel_member()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.channel_id = '10000000-0000-4000-8000-000000000011'::uuid THEN
    RAISE EXCEPTION 'forced roster failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER fail_selected_channel_member
BEFORE INSERT ON public.channel_members
FOR EACH ROW EXECUTE FUNCTION public.fail_selected_channel_member();
SQL
expect_failure "SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.create_group_channel_atomic('10000000-0000-4000-8000-000000000011','11111111-1111-4111-8111-111111111111','Rollback',NULL,ARRAY['22222222-2222-4222-8222-222222222222']::uuid[])"
if [[ "$(psql_cmd -Atqc "SELECT (SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000011') + (SELECT pg_catalog.count(*) FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000011')")" != "0" ]]; then
  echo "Roster failure left a channel or partial members" >&2
  exit 1
fi
psql_cmd -c "DROP TRIGGER fail_selected_channel_member ON public.channel_members; DROP FUNCTION public.fail_selected_channel_member()" >/dev/null

# Race A1: a block commits first while holding the shared pair key. Creation
# waits, observes the block, and leaves no channel.
PGAPPNAME=block_first psql_cmd -Atqc \
  "BEGIN; INSERT INTO public.blocked_users VALUES ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'); SELECT pg_catalog.pg_sleep(2); COMMIT" \
  >"$TMP_ROOT/block-first.out" 2>&1 &
BLOCK_PID=$!
expect_activity_wait block_first Timeout PgSleep
psql_cmd -Atqc "$(service_call_sql '10000000-0000-4000-8000-000000000012' '11111111-1111-4111-8111-111111111111' 'Block first' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >"$TMP_ROOT/create-after-block.out"
wait "$BLOCK_PID"
grep -q 'PRIVACY_DENIED' "$TMP_ROOT/create-after-block.out"
psql_cmd -c "DELETE FROM public.blocked_users WHERE blocker_id='11111111-1111-4111-8111-111111111111' AND blocked_id='22222222-2222-4222-8222-222222222222'" >/dev/null

# A reusable test-only pause runs after privacy validation while the creator
# still owns channel/Auth/pair locks.
psql_cmd <<'SQL'
CREATE FUNCTION public.pause_selected_channel_insert()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.id::text = pg_catalog.current_setting('test.pause_channel_id', true) THEN
    PERFORM pg_catalog.pg_sleep(3);
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER pause_selected_channel_insert
BEFORE INSERT ON public.chat_channels
FOR EACH ROW EXECUTE FUNCTION public.pause_selected_channel_insert();

CREATE FUNCTION public.pause_selected_channel_member_insert()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.channel_id::text = pg_catalog.current_setting(
    'test.pause_member_add_channel',
    true
  ) THEN
    PERFORM pg_catalog.pg_sleep(3);
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER pause_selected_channel_member_insert
BEFORE INSERT ON public.channel_members
FOR EACH ROW EXECUTE FUNCTION public.pause_selected_channel_member_insert();
SQL

# Race A2: creation linearizes first; a later block waits on its pair key.
PGAPPNAME=create_before_block psql_cmd -Atqc \
  "SET test.pause_channel_id='10000000-0000-4000-8000-000000000013'; $(service_call_sql '10000000-0000-4000-8000-000000000013' '11111111-1111-4111-8111-111111111111' 'Create before block' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >"$TMP_ROOT/create-before-block.out" 2>&1 &
CREATE_PID=$!
expect_activity_wait create_before_block Timeout PgSleep
PGAPPNAME=block_after_create psql_cmd -Atqc \
  "INSERT INTO public.blocked_users VALUES ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222')" \
  >"$TMP_ROOT/block-after-create.out" 2>&1 &
EDGE_PID=$!
expect_activity_wait block_after_create Lock
wait "$CREATE_PID"
wait "$EDGE_PID"
grep -q '"success": true' "$TMP_ROOT/create-before-block.out"
psql_cmd -c "DELETE FROM public.blocked_users WHERE blocker_id='11111111-1111-4111-8111-111111111111' AND blocked_id='22222222-2222-4222-8222-222222222222'" >/dev/null

# Race B1: mutual follow deletion commits first; creation waits and denies.
PGAPPNAME=follow_delete_first psql_cmd -Atqc \
  "BEGIN; DELETE FROM public.user_follows WHERE follower_id='11111111-1111-4111-8111-111111111111' AND following_id='33333333-3333-4333-8333-333333333333'; SELECT pg_catalog.pg_sleep(2); COMMIT" \
  >"$TMP_ROOT/follow-delete-first.out" 2>&1 &
FOLLOW_PID=$!
expect_activity_wait follow_delete_first Timeout PgSleep
psql_cmd -Atqc "$(service_call_sql '10000000-0000-4000-8000-000000000014' '11111111-1111-4111-8111-111111111111' 'Follow first' 'NULL' "'33333333-3333-4333-8333-333333333333'")" \
  >"$TMP_ROOT/create-after-follow-delete.out"
wait "$FOLLOW_PID"
grep -q 'PRIVACY_DENIED' "$TMP_ROOT/create-after-follow-delete.out"
psql_cmd -c "INSERT INTO public.user_follows VALUES ('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333')" >/dev/null

# Race B2: creation linearizes first; a later mutual-follow delete waits.
PGAPPNAME=create_before_follow_delete psql_cmd -Atqc \
  "SET test.pause_channel_id='10000000-0000-4000-8000-000000000015'; $(service_call_sql '10000000-0000-4000-8000-000000000015' '11111111-1111-4111-8111-111111111111' 'Create before follow' 'NULL' "'33333333-3333-4333-8333-333333333333'")" \
  >"$TMP_ROOT/create-before-follow-delete.out" 2>&1 &
CREATE_PID=$!
expect_activity_wait create_before_follow_delete Timeout PgSleep
PGAPPNAME=follow_delete_after_create psql_cmd -Atqc \
  "DELETE FROM public.user_follows WHERE follower_id='11111111-1111-4111-8111-111111111111' AND following_id='33333333-3333-4333-8333-333333333333'" \
  >"$TMP_ROOT/follow-delete-after-create.out" 2>&1 &
EDGE_PID=$!
expect_activity_wait follow_delete_after_create Lock
wait "$CREATE_PID"
wait "$EDGE_PID"
grep -q '"success": true' "$TMP_ROOT/create-before-follow-delete.out"
psql_cmd -c "INSERT INTO public.user_follows VALUES ('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333')" >/dev/null

# Race C1: creator Auth deletion owns the parent first. Fresh creation waits,
# then returns ACTOR_UNAVAILABLE without a deadlock or channel.
PGAPPNAME=creator_delete_first psql_cmd -Atqc \
  "BEGIN; DELETE FROM auth.users WHERE id='77777777-7777-4777-8777-777777777777'; SELECT pg_catalog.pg_sleep(2); COMMIT" \
  >"$TMP_ROOT/creator-delete-first.out" 2>&1 &
DELETE_PID=$!
expect_activity_wait creator_delete_first Timeout PgSleep
psql_cmd -Atqc "$(service_call_sql '10000000-0000-4000-8000-000000000016' '77777777-7777-4777-8777-777777777777' 'Deleted creator' 'NULL' "'88888888-8888-4888-8888-888888888888'")" \
  >"$TMP_ROOT/create-after-creator-delete.out"
wait "$DELETE_PID"
grep -q 'ACTOR_UNAVAILABLE' "$TMP_ROOT/create-after-creator-delete.out"
psql_cmd -c "INSERT INTO auth.users VALUES ('77777777-7777-4777-8777-777777777777'); INSERT INTO public.user_profiles VALUES ('77777777-7777-4777-8777-777777777777','all',NULL,NULL,false,NULL)" >/dev/null

# Race C2: creation owns creator Auth SHARE first. A hard-delete statement waits
# and is rolled back after creation commits, proving the reverse barrier without
# deliberately destroying the newly created owner invariant.
PGAPPNAME=create_before_creator_delete psql_cmd -Atqc \
  "SET test.pause_channel_id='10000000-0000-4000-8000-000000000017'; $(service_call_sql '10000000-0000-4000-8000-000000000017' '77777777-7777-4777-8777-777777777777' 'Create before creator delete' 'NULL' "'88888888-8888-4888-8888-888888888888'")" \
  >"$TMP_ROOT/create-before-creator-delete.out" 2>&1 &
CREATE_PID=$!
expect_activity_wait create_before_creator_delete Timeout PgSleep
PGAPPNAME=creator_delete_after_create psql_cmd -Atqc \
  "BEGIN; DELETE FROM auth.users WHERE id='77777777-7777-4777-8777-777777777777'; ROLLBACK" \
  >"$TMP_ROOT/creator-delete-after-create.out" 2>&1 &
DELETE_PID=$!
expect_activity_wait creator_delete_after_create Lock
wait "$CREATE_PID"
wait "$DELETE_PID"
grep -q '"success": true' "$TMP_ROOT/create-before-creator-delete.out"

# Race C3: creator deletion owns the exclusive owner barrier first and removes
# the ownerless group. Replay waits at its lock-free entry, then denies the now
# unavailable actor without deadlocking or recreating the deleted channel.
PGAPPNAME=existing_creator_delete psql_cmd -Atqc \
  "BEGIN; DELETE FROM auth.users WHERE id='77777777-7777-4777-8777-777777777777'; SELECT pg_catalog.pg_sleep(2); COMMIT" \
  >"$TMP_ROOT/existing-creator-delete.out" 2>&1 &
DELETE_PID=$!
expect_activity_wait existing_creator_delete Timeout PgSleep
psql_cmd -Atqc "$(service_call_sql '10000000-0000-4000-8000-000000000017' '77777777-7777-4777-8777-777777777777' 'Create before creator delete' 'NULL' "'88888888-8888-4888-8888-888888888888'")" \
  >"$TMP_ROOT/replay-during-creator-delete.out"
wait "$DELETE_PID"
grep -q 'ACTOR_UNAVAILABLE' "$TMP_ROOT/replay-during-creator-delete.out"
psql_cmd -c "INSERT INTO auth.users VALUES ('77777777-7777-4777-8777-777777777777'); INSERT INTO public.user_profiles VALUES ('77777777-7777-4777-8777-777777777777','all',NULL,NULL,false,NULL)" >/dev/null

# Race D: same-ID concurrent requests serialize into one physical channel and
# both receive a verified success (fresh + exact replay).
for suffix in one two; do
  PGAPPNAME="same_id_$suffix" psql_cmd -Atqc \
    "$(service_call_sql '10000000-0000-4000-8000-000000000018' '11111111-1111-4111-8111-111111111111' 'Same id' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
    >"$TMP_ROOT/same-id-$suffix.out" 2>&1 &
  if [[ "$suffix" == "one" ]]; then FIRST_PID=$!; else SECOND_PID=$!; fi
done
wait "$FIRST_PID"
wait "$SECOND_PID"
grep -q '"success": true' "$TMP_ROOT/same-id-one.out"
grep -q '"success": true' "$TMP_ROOT/same-id-two.out"

# Race E: distinct intents with the same candidate batch both complete without
# deadlock and each owns an exact two-person roster.
for suffix in 19 20; do
  PGAPPNAME="same_batch_$suffix" psql_cmd -Atqc \
    "$(service_call_sql "10000000-0000-4000-8000-0000000000$suffix" '11111111-1111-4111-8111-111111111111' "Batch $suffix" 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
    >"$TMP_ROOT/same-batch-$suffix.out" 2>&1 &
  if [[ "$suffix" == "19" ]]; then FIRST_PID=$!; else SECOND_PID=$!; fi
done
wait "$FIRST_PID"
wait "$SECOND_PID"
grep -q '"success": true' "$TMP_ROOT/same-batch-19.out"
grep -q '"success": true' "$TMP_ROOT/same-batch-20.out"

# Race E2: completely disjoint creators/candidates share no Auth or pair locks.
# The first create pauses after its exclusive owner barrier; the second must wait
# at its lock-free entry and then succeed, never surface the trigger's 40001.
PGAPPNAME=disjoint_create_first psql_cmd -Atqc \
  "SET test.pause_channel_id='10000000-0000-4000-8000-000000000031'; $(service_call_sql '10000000-0000-4000-8000-000000000031' '11111111-1111-4111-8111-111111111111' 'Disjoint one' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >"$TMP_ROOT/disjoint-create-first.out" 2>&1 &
FIRST_PID=$!
expect_activity_wait disjoint_create_first Timeout PgSleep
PGAPPNAME=disjoint_create_second psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000032' '77777777-7777-4777-8777-777777777777' 'Disjoint two' 'NULL' "'88888888-8888-4888-8888-888888888888'")" \
  >"$TMP_ROOT/disjoint-create-second.out" 2>&1 &
SECOND_PID=$!
expect_activity_wait disjoint_create_second Lock
wait "$FIRST_PID"
wait "$SECOND_PID"
grep -q '"success": true' "$TMP_ROOT/disjoint-create-first.out"
grep -q '"success": true' "$TMP_ROOT/disjoint-create-second.out"
if grep -qE '40001|deadlock detected|group-channel owner mutation is concurrent' \
  "$TMP_ROOT/disjoint-create-first.out" "$TMP_ROOT/disjoint-create-second.out"; then
  echo "Disjoint normal creates did not wait cleanly on the owner barrier" >&2
  exit 1
fi

# Race F1/F2: existing-member addition and create/replay share the exact channel
# advisory namespace in both directions, so neither can observe partial roster
# state or run concurrently for one channel UUID.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000021' '11111111-1111-4111-8111-111111111111' 'Before member add' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >/dev/null
PGAPPNAME=member_add_before_create psql_cmd -Atqc \
  "SET test.pause_member_add_channel='10000000-0000-4000-8000-000000000021'; $(add_call_sql '10000000-0000-4000-8000-000000000021' '11111111-1111-4111-8111-111111111111' "'88888888-8888-4888-8888-888888888888'")" \
  >"$TMP_ROOT/member-add-before-create.out" 2>&1 &
ADD_PID=$!
expect_activity_wait member_add_before_create Timeout PgSleep
PGAPPNAME=create_after_member_add psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000021' '11111111-1111-4111-8111-111111111111' 'Before member add' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >"$TMP_ROOT/create-after-member-add.out" 2>&1 &
CREATE_PID=$!
expect_activity_wait create_after_member_add Lock
wait "$ADD_PID"
wait "$CREATE_PID"
grep -q '"added": 1' "$TMP_ROOT/member-add-before-create.out"
grep -q 'CHANNEL_ID_CONFLICT' "$TMP_ROOT/create-after-member-add.out"

PGAPPNAME=create_before_member_add psql_cmd -Atqc \
  "SET test.pause_channel_id='10000000-0000-4000-8000-000000000022'; $(service_call_sql '10000000-0000-4000-8000-000000000022' '11111111-1111-4111-8111-111111111111' 'Before member add' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >"$TMP_ROOT/create-before-member-add.out" 2>&1 &
CREATE_PID=$!
expect_activity_wait create_before_member_add Timeout PgSleep
PGAPPNAME=member_add_after_create psql_cmd -Atqc \
  "$(add_call_sql '10000000-0000-4000-8000-000000000022' '11111111-1111-4111-8111-111111111111' "'22222222-2222-4222-8222-222222222222'")" \
  >"$TMP_ROOT/member-add-after-create.out" 2>&1 &
ADD_PID=$!
expect_activity_wait member_add_after_create Lock
wait "$CREATE_PID"
wait "$ADD_PID"
grep -q '"success": true' "$TMP_ROOT/create-before-member-add.out"
grep -q '"added": 0' "$TMP_ROOT/member-add-after-create.out"

# Race G1: creator hard-delete owns the exclusive owner barrier first. add v2
# waits on its shared barrier before taking any other lock, then observes the
# deleted group and returns a stable not-found denial without a deadlock.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000026' '77777777-7777-4777-8777-777777777777' 'Add delete first' 'NULL' "'88888888-8888-4888-8888-888888888888'")" \
  >/dev/null
PGAPPNAME=add_creator_delete_first psql_cmd -Atqc \
  "BEGIN; DELETE FROM auth.users WHERE id='77777777-7777-4777-8777-777777777777'; SELECT pg_catalog.pg_sleep(2); COMMIT" \
  >"$TMP_ROOT/add-creator-delete-first.out" 2>&1 &
DELETE_PID=$!
expect_activity_wait add_creator_delete_first Timeout PgSleep
psql_cmd -Atqc \
  "$(add_call_sql '10000000-0000-4000-8000-000000000026' '77777777-7777-4777-8777-777777777777' "'22222222-2222-4222-8222-222222222222'")" \
  >"$TMP_ROOT/add-after-creator-delete.out" 2>&1
wait "$DELETE_PID"
grep -q 'CHANNEL_NOT_FOUND' "$TMP_ROOT/add-after-creator-delete.out"
psql_cmd -c "INSERT INTO auth.users VALUES ('77777777-7777-4777-8777-777777777777'); INSERT INTO public.user_profiles VALUES ('77777777-7777-4777-8777-777777777777','all',NULL,NULL,false,NULL)" >/dev/null

# Race G2: add v2 owns creator Auth SHARE first. A creator hard-delete waits;
# rolling it back after add commits proves the reverse barrier and preserves the
# exact existing add acknowledgement.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000027' '77777777-7777-4777-8777-777777777777' 'Add before delete' 'NULL' "'88888888-8888-4888-8888-888888888888'")" \
  >/dev/null
PGAPPNAME=add_before_creator_delete psql_cmd -Atqc \
  "SET test.pause_member_add_channel='10000000-0000-4000-8000-000000000027'; $(add_call_sql '10000000-0000-4000-8000-000000000027' '77777777-7777-4777-8777-777777777777' "'22222222-2222-4222-8222-222222222222'")" \
  >"$TMP_ROOT/add-before-creator-delete.out" 2>&1 &
ADD_PID=$!
expect_activity_wait add_before_creator_delete Timeout PgSleep
PGAPPNAME=creator_delete_after_add psql_cmd -Atqc \
  "BEGIN; DELETE FROM auth.users WHERE id='77777777-7777-4777-8777-777777777777'; ROLLBACK" \
  >"$TMP_ROOT/creator-delete-after-add.out" 2>&1 &
DELETE_PID=$!
expect_activity_wait creator_delete_after_add Lock
wait "$ADD_PID"
wait "$DELETE_PID"
grep -q '"added": 1' "$TMP_ROOT/add-before-creator-delete.out"
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000027'")" != "3" ]]; then
  echo "Creator-delete reverse barrier lost the added member" >&2
  exit 1
fi

# This test-only trigger sorts after the canonical BEFORE serializer. The
# winning owner mutation therefore pauses while already owning the global key;
# a competing mutation must fail immediately with 40001 instead of waiting in
# a tuple-lock/global-lock cycle.
psql_cmd <<'SQL'
CREATE FUNCTION public.pause_serialized_owner_event()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  v_channel_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.channel_id ELSE NEW.channel_id END;
BEGIN
  IF v_channel_id::text = pg_catalog.current_setting(
    'test.pause_owner_channel',
    true
  ) THEN
    PERFORM pg_catalog.set_config('test.pause_owner_channel', '', true);
    PERFORM pg_catalog.pg_sleep(3);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
CREATE TRIGGER zz_pause_serialized_owner_event
BEFORE INSERT OR DELETE OR UPDATE OF role, channel_id, user_id
ON public.channel_members
FOR EACH ROW EXECUTE FUNCTION public.pause_serialized_owner_event();

CREATE FUNCTION public.pause_channel_parent_delete()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.id::text = pg_catalog.current_setting(
    'test.pause_parent_delete_channel',
    true
  ) THEN
    PERFORM pg_catalog.pg_sleep(3);
  END IF;
  RETURN OLD;
END
$function$;
CREATE TRIGGER aa_pause_channel_parent_delete
BEFORE DELETE ON public.chat_channels
FOR EACH ROW EXECUTE FUNCTION public.pause_channel_parent_delete();

CREATE FUNCTION public.pause_auth_member_delete()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.channel_id::text || ':' || OLD.user_id::text =
    pg_catalog.current_setting('test.pause_auth_member_delete', true)
  THEN
    PERFORM pg_catalog.set_config('test.pause_auth_member_delete', '', true);
    PERFORM pg_catalog.pg_sleep(3);
  END IF;
  RETURN OLD;
END
$function$;
CREATE TRIGGER aa_pause_auth_member_delete
BEFORE DELETE ON public.channel_members
FOR EACH ROW EXECUTE FUNCTION public.pause_auth_member_delete();

-- Alphabetic trigger order places this after the canonical parent serializer.
-- A paused session therefore already owns the channel/global/creator guard.
CREATE FUNCTION public.pause_guarded_channel_parent_delete()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.id::text = pg_catalog.current_setting(
    'test.pause_guarded_parent_delete_channel',
    true
  ) THEN
    PERFORM pg_catalog.set_config(
      'test.pause_guarded_parent_delete_channel',
      '',
      true
    );
    PERFORM pg_catalog.pg_sleep(3);
  END IF;
  RETURN OLD;
END
$function$;
CREATE TRIGGER zz_pause_guarded_channel_parent_delete
BEFORE DELETE ON public.chat_channels
FOR EACH ROW EXECUTE FUNCTION public.pause_guarded_channel_parent_delete();
SQL

# Owner-loss invariant covers both DELETE and UPDATE, while the deferred
# constraint trigger permits an atomic owner transfer completed in one txn.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000023' '11111111-1111-4111-8111-111111111111' 'Owner demotion' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >/dev/null
psql_cmd -c "UPDATE public.channel_members SET role='member' WHERE channel_id='10000000-0000-4000-8000-000000000023' AND role='owner'" >/dev/null
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000023'")" != "0" ]]; then
  echo "Owner demotion left an ownerless group" >&2
  exit 1
fi

psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000024' '11111111-1111-4111-8111-111111111111' 'Owner transfer' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >/dev/null
psql_cmd -c "BEGIN; UPDATE public.channel_members SET role='owner' WHERE channel_id='10000000-0000-4000-8000-000000000024' AND user_id='22222222-2222-4222-8222-222222222222'; UPDATE public.channel_members SET role='member' WHERE channel_id='10000000-0000-4000-8000-000000000024' AND user_id='11111111-1111-4111-8111-111111111111'; COMMIT" >/dev/null
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000024'")" != "1" ]] || [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000024' AND role='owner'")" != "1" ]]; then
  echo "Deferred owner transfer did not preserve exactly one owner" >&2
  exit 1
fi

psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000025' '11111111-1111-4111-8111-111111111111' 'Double owner rollback' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >/dev/null
expect_failure "UPDATE public.channel_members SET role='owner' WHERE channel_id='10000000-0000-4000-8000-000000000025' AND user_id='22222222-2222-4222-8222-222222222222'"
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000025' AND role='owner'")" != "1" ]] || [[ "$(psql_cmd -Atqc "SELECT role FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000025' AND user_id='22222222-2222-4222-8222-222222222222'")" != "member" ]]; then
  echo "Double-owner rejection did not roll the member promotion back" >&2
  exit 1
fi

# Add-first direction: hold the per-channel advisory so add owns only the shared
# global owner barrier. A direct owner promotion can lock its tuple, but its
# exclusive try-lock must fail immediately and release it; add then completes.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000042' '11111111-1111-4111-8111-111111111111' 'Add shared first' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >/dev/null
PGAPPNAME=hold_add_shared_channel psql_cmd -Atqc \
  "BEGIN; SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('channel-membership:channel:10000000-0000-4000-8000-000000000042',0)); SELECT pg_catalog.pg_sleep(3); COMMIT" \
  >"$TMP_ROOT/hold-add-shared-channel.out" 2>&1 &
HOLDER_PID=$!
expect_activity_wait hold_add_shared_channel Timeout PgSleep
PGAPPNAME=add_shared_first psql_cmd -Atqc \
  "$(add_call_sql '10000000-0000-4000-8000-000000000042' '11111111-1111-4111-8111-111111111111' "'88888888-8888-4888-8888-888888888888'")" \
  >"$TMP_ROOT/add-shared-first.out" 2>&1 &
ADD_PID=$!
expect_activity_wait add_shared_first Lock
set +e
psql_cmd -Atqc \
  "UPDATE public.channel_members SET role='owner' WHERE channel_id='10000000-0000-4000-8000-000000000042' AND user_id='22222222-2222-4222-8222-222222222222'" \
  >"$TMP_ROOT/owner-after-add-shared.out" 2>&1
OWNER_STATUS=$?
set -e
wait "$HOLDER_PID"
wait "$ADD_PID"
if ((OWNER_STATUS == 0)); then
  echo "Owner mutation bypassed add's shared owner barrier" >&2
  exit 1
fi
grep -q 'group-channel owner mutation is concurrent; retry' \
  "$TMP_ROOT/owner-after-add-shared.out"
grep -q '"added": 1' "$TMP_ROOT/add-shared-first.out"

# Owner-first direction: a direct owner promotion owns the exclusive barrier;
# add waits at its shared lock before taking channel/Auth/tuple locks, then
# completes after the invalid double-owner transaction rolls back.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000043' '11111111-1111-4111-8111-111111111111' 'Owner before add' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >/dev/null
PGAPPNAME=owner_before_add psql_cmd -Atqc \
  "SET test.pause_owner_channel='10000000-0000-4000-8000-000000000043'; UPDATE public.channel_members SET role='owner' WHERE channel_id='10000000-0000-4000-8000-000000000043' AND user_id='22222222-2222-4222-8222-222222222222'" \
  >"$TMP_ROOT/owner-before-add.out" 2>&1 &
OWNER_PID=$!
expect_activity_wait owner_before_add Timeout PgSleep
PGAPPNAME=add_after_owner psql_cmd -Atqc \
  "$(add_call_sql '10000000-0000-4000-8000-000000000043' '11111111-1111-4111-8111-111111111111' "'88888888-8888-4888-8888-888888888888'")" \
  >"$TMP_ROOT/add-after-owner.out" 2>&1 &
ADD_PID=$!
expect_activity_wait add_after_owner Lock
set +e
wait "$OWNER_PID"
OWNER_STATUS=$?
set -e
wait "$ADD_PID"
if ((OWNER_STATUS == 0)); then
  echo "Invalid owner promotion unexpectedly committed before add" >&2
  exit 1
fi
grep -q 'group channel must have exactly one owner' "$TMP_ROOT/owner-before-add.out"
grep -q '"added": 1' "$TMP_ROOT/add-after-owner.out"

# Owner-first parent deletion: DELETE locks the parent, then its canonical
# exclusive try-lock fails rather than waiting on the owner holder.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000044' '11111111-1111-4111-8111-111111111111' 'Owner before parent' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >/dev/null
PGAPPNAME=owner_before_parent_delete psql_cmd -Atqc \
  "SET test.pause_owner_channel='10000000-0000-4000-8000-000000000044'; UPDATE public.channel_members SET role='owner' WHERE channel_id='10000000-0000-4000-8000-000000000044' AND user_id='22222222-2222-4222-8222-222222222222'" \
  >"$TMP_ROOT/owner-before-parent-delete.out" 2>&1 &
OWNER_PID=$!
expect_activity_wait owner_before_parent_delete Timeout PgSleep
set +e
psql_cmd -Atqc \
  "DELETE FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000044'" \
  >"$TMP_ROOT/parent-delete-after-owner.out" 2>&1
DELETE_STATUS=$?
wait "$OWNER_PID"
OWNER_STATUS=$?
set -e
if ((DELETE_STATUS == 0 || OWNER_STATUS == 0)); then
  echo "Owner/parent adversary unexpectedly committed" >&2
  exit 1
fi
grep -q 'group-channel owner mutation is concurrent; retry' \
  "$TMP_ROOT/parent-delete-after-owner.out"
grep -q 'group channel must have exactly one owner' \
  "$TMP_ROOT/owner-before-parent-delete.out"

# Parent-first direction reconstructs the old channel -> owner-row / owner-row
# -> channel ring. The parent sleeps while holding its tuple but before the
# canonical trigger; the owner takes exclusive, so the parent try-lock aborts
# with 40001 and releases the channel instead of reaching 40P01.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000045' '11111111-1111-4111-8111-111111111111' 'Parent before owner' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >/dev/null
PGAPPNAME=parent_delete_before_owner psql_cmd -Atqc \
  "SET test.pause_parent_delete_channel='10000000-0000-4000-8000-000000000045'; DELETE FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000045'" \
  >"$TMP_ROOT/parent-delete-before-owner.out" 2>&1 &
DELETE_PID=$!
expect_activity_wait parent_delete_before_owner Timeout PgSleep
PGAPPNAME=owner_after_parent_delete psql_cmd -Atqc \
  "UPDATE public.channel_members SET role='owner' WHERE channel_id='10000000-0000-4000-8000-000000000045' AND user_id='22222222-2222-4222-8222-222222222222'" \
  >"$TMP_ROOT/owner-after-parent-delete.out" 2>&1 &
OWNER_PID=$!
expect_activity_wait owner_after_parent_delete Lock
set +e
wait "$DELETE_PID"
DELETE_STATUS=$?
wait "$OWNER_PID"
OWNER_STATUS=$?
set -e
if ((DELETE_STATUS == 0 || OWNER_STATUS == 0)); then
  echo "Parent/owner adversary unexpectedly committed" >&2
  exit 1
fi
grep -q 'group-channel owner mutation is concurrent; retry' \
  "$TMP_ROOT/parent-delete-before-owner.out"
grep -q 'group channel must have exactly one owner' \
  "$TMP_ROOT/owner-after-parent-delete.out"
if grep -q 'deadlock detected' \
  "$TMP_ROOT/owner-before-parent-delete.out" \
  "$TMP_ROOT/parent-delete-after-owner.out" \
  "$TMP_ROOT/parent-delete-before-owner.out" \
  "$TMP_ROOT/owner-after-parent-delete.out"; then
  echo "Owner/parent serialization reached a deadlock" >&2
  exit 1
fi

# Transfer-first: the new owner commits while dissolve waits at its lock-free
# exclusive entry; the stale former owner is denied against the final roster.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000046' '11111111-1111-4111-8111-111111111111' 'Transfer before dissolve' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >/dev/null
PGAPPNAME=transfer_before_dissolve psql_cmd -Atqc \
  "BEGIN; SET test.pause_owner_channel='10000000-0000-4000-8000-000000000046'; UPDATE public.channel_members SET role='owner' WHERE channel_id='10000000-0000-4000-8000-000000000046' AND user_id='22222222-2222-4222-8222-222222222222'; UPDATE public.channel_members SET role='member' WHERE channel_id='10000000-0000-4000-8000-000000000046' AND user_id='11111111-1111-4111-8111-111111111111'; COMMIT" \
  >"$TMP_ROOT/transfer-before-dissolve.out" 2>&1 &
TRANSFER_PID=$!
expect_activity_wait transfer_before_dissolve Timeout PgSleep
PGAPPNAME=dissolve_after_transfer psql_cmd -Atqc \
  "$(dissolve_call_sql '10000000-0000-4000-8000-000000000046' '11111111-1111-4111-8111-111111111111')" \
  >"$TMP_ROOT/dissolve-after-transfer.out" 2>&1 &
DISSOLVE_PID=$!
expect_activity_wait dissolve_after_transfer Lock
wait "$TRANSFER_PID"
wait "$DISSOLVE_PID"
grep -q 'PERMISSION_DENIED' "$TMP_ROOT/dissolve-after-transfer.out"
if [[ "$(psql_cmd -Atqc "SELECT role FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000046' AND user_id='22222222-2222-4222-8222-222222222222'")" != "owner" ]]; then
  echo "Stale-owner dissolution corrupted the transferred owner" >&2
  exit 1
fi

# Dissolve-first: hold its channel advisory after it owns exclusive global. A
# competing transfer fails its owner try-lock; dissolution then deletes exactly
# once after the test holder releases the channel key.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000047' '11111111-1111-4111-8111-111111111111' 'Dissolve before transfer' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >/dev/null
PGAPPNAME=hold_dissolve_channel psql_cmd -Atqc \
  "BEGIN; SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('channel-membership:channel:10000000-0000-4000-8000-000000000047',0)); SELECT pg_catalog.pg_sleep(3); COMMIT" \
  >"$TMP_ROOT/hold-dissolve-channel.out" 2>&1 &
HOLDER_PID=$!
expect_activity_wait hold_dissolve_channel Timeout PgSleep
PGAPPNAME=dissolve_before_transfer psql_cmd -Atqc \
  "$(dissolve_call_sql '10000000-0000-4000-8000-000000000047' '11111111-1111-4111-8111-111111111111')" \
  >"$TMP_ROOT/dissolve-before-transfer.out" 2>&1 &
DISSOLVE_PID=$!
expect_activity_wait dissolve_before_transfer Lock
set +e
psql_cmd -Atqc \
  "BEGIN; UPDATE public.channel_members SET role='owner' WHERE channel_id='10000000-0000-4000-8000-000000000047' AND user_id='22222222-2222-4222-8222-222222222222'; UPDATE public.channel_members SET role='member' WHERE channel_id='10000000-0000-4000-8000-000000000047' AND user_id='11111111-1111-4111-8111-111111111111'; COMMIT" \
  >"$TMP_ROOT/transfer-after-dissolve.out" 2>&1
TRANSFER_STATUS=$?
set -e
wait "$HOLDER_PID"
wait "$DISSOLVE_PID"
if ((TRANSFER_STATUS == 0)); then
  echo "Owner transfer bypassed an in-flight atomic dissolution" >&2
  exit 1
fi
grep -q 'group-channel owner mutation is concurrent; retry' \
  "$TMP_ROOT/transfer-after-dissolve.out"
grep -q '"applied": true' "$TMP_ROOT/dissolve-before-transfer.out"
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000047'")" != "0" ]]; then
  echo "Atomic dissolve-first race left the channel behind" >&2
  exit 1
fi

# Transfer then creator-delete first: A remains created_by and an ordinary
# member after B becomes owner. The Auth cascade owns A's parent/member first;
# dissolve waits at canonical Auth locking, detects the final identity drift,
# and a retry produces the one exact deletion.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000048' 'a0000000-0000-4000-8000-000000000001' 'Creator delete before dissolve' 'NULL' "'b0000000-0000-4000-8000-000000000001'")" \
  >/dev/null
psql_cmd -c "BEGIN; UPDATE public.channel_members SET role='owner' WHERE channel_id='10000000-0000-4000-8000-000000000048' AND user_id='b0000000-0000-4000-8000-000000000001'; UPDATE public.channel_members SET role='member' WHERE channel_id='10000000-0000-4000-8000-000000000048' AND user_id='a0000000-0000-4000-8000-000000000001'; COMMIT" >/dev/null
PGAPPNAME=dissolve_creator_delete_first psql_cmd -Atqc \
  "SET test.pause_auth_member_delete='10000000-0000-4000-8000-000000000048:a0000000-0000-4000-8000-000000000001'; DELETE FROM auth.users WHERE id='a0000000-0000-4000-8000-000000000001'" \
  >"$TMP_ROOT/dissolve-creator-delete-first.out" 2>&1 &
DELETE_PID=$!
expect_activity_wait dissolve_creator_delete_first Timeout PgSleep
PGAPPNAME=dissolve_after_creator_delete psql_cmd -Atqc \
  "$(dissolve_call_sql '10000000-0000-4000-8000-000000000048' 'b0000000-0000-4000-8000-000000000001')" \
  >"$TMP_ROOT/dissolve-after-creator-delete.out" 2>&1 &
DISSOLVE_PID=$!
expect_activity_wait dissolve_after_creator_delete Lock
wait "$DELETE_PID"
set +e
wait "$DISSOLVE_PID"
DISSOLVE_STATUS=$?
set -e
if ((DISSOLVE_STATUS == 0)); then
  echo "Dissolve accepted an Auth identity that changed while locking" >&2
  exit 1
fi
grep -q 'group-channel identity changed while locking; retry' \
  "$TMP_ROOT/dissolve-after-creator-delete.out"
psql_cmd -Atqc \
  "$(dissolve_call_sql '10000000-0000-4000-8000-000000000048' 'b0000000-0000-4000-8000-000000000001')" \
  >"$TMP_ROOT/dissolve-after-creator-delete-retry.out"
grep -q '"applied": true' \
  "$TMP_ROOT/dissolve-after-creator-delete-retry.out"
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000048'")" != "0" ]]; then
  echo "Creator-delete-first dissolve retry left the channel behind" >&2
  exit 1
fi

# Reverse direction: dissolve owns both creator/owner Auth SHARE locks before
# waiting on a deliberately held channel tuple. Creator hard deletion must wait
# at Auth, then finish after the exact successful dissolution.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000049' 'a0000000-0000-4000-8000-000000000002' 'Dissolve before creator delete' 'NULL' "'b0000000-0000-4000-8000-000000000002'")" \
  >/dev/null
psql_cmd -c "BEGIN; UPDATE public.channel_members SET role='owner' WHERE channel_id='10000000-0000-4000-8000-000000000049' AND user_id='b0000000-0000-4000-8000-000000000002'; UPDATE public.channel_members SET role='member' WHERE channel_id='10000000-0000-4000-8000-000000000049' AND user_id='a0000000-0000-4000-8000-000000000002'; COMMIT" >/dev/null
PGAPPNAME=hold_dissolve_creator_channel psql_cmd -Atqc \
  "BEGIN; SELECT 1 FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000049' FOR UPDATE; SELECT pg_catalog.pg_sleep(3); COMMIT" \
  >"$TMP_ROOT/hold-dissolve-creator-channel.out" 2>&1 &
HOLDER_PID=$!
expect_activity_wait hold_dissolve_creator_channel Timeout PgSleep
PGAPPNAME=dissolve_before_creator_delete psql_cmd -Atqc \
  "$(dissolve_call_sql '10000000-0000-4000-8000-000000000049' 'b0000000-0000-4000-8000-000000000002')" \
  >"$TMP_ROOT/dissolve-before-creator-delete.out" 2>&1 &
DISSOLVE_PID=$!
expect_activity_wait dissolve_before_creator_delete Lock
PGAPPNAME=creator_delete_after_dissolve psql_cmd -Atqc \
  "DELETE FROM auth.users WHERE id='a0000000-0000-4000-8000-000000000002'" \
  >"$TMP_ROOT/creator-delete-after-dissolve.out" 2>&1 &
DELETE_PID=$!
expect_activity_wait creator_delete_after_dissolve Lock
wait "$HOLDER_PID"
wait "$DISSOLVE_PID"
wait "$DELETE_PID"
grep -q '"applied": true' "$TMP_ROOT/dissolve-before-creator-delete.out"
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000049'")" != "0" ]]; then
  echo "Dissolve-first creator deletion left the channel behind" >&2
  exit 1
fi

# After transfer, concurrent Auth deletion of old creator A and current owner B
# exercises the deferred cleanup's parent DELETE. Auth-A-first must make the
# parent's creator NOWAIT guard fail with 40001, never wait channel -> Auth.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000050' 'a0000000-0000-4000-8000-000000000003' 'Creator before owner cleanup' 'NULL' "'b0000000-0000-4000-8000-000000000003'")" \
  >/dev/null
psql_cmd -c "BEGIN; UPDATE public.channel_members SET role='owner' WHERE channel_id='10000000-0000-4000-8000-000000000050' AND user_id='b0000000-0000-4000-8000-000000000003'; UPDATE public.channel_members SET role='member' WHERE channel_id='10000000-0000-4000-8000-000000000050' AND user_id='a0000000-0000-4000-8000-000000000003'; COMMIT" >/dev/null
PGAPPNAME=old_creator_delete_before_cleanup psql_cmd -Atqc \
  "SET test.pause_auth_member_delete='10000000-0000-4000-8000-000000000050:a0000000-0000-4000-8000-000000000003'; DELETE FROM auth.users WHERE id='a0000000-0000-4000-8000-000000000003'" \
  >"$TMP_ROOT/old-creator-delete-before-cleanup.out" 2>&1 &
CREATOR_DELETE_PID=$!
expect_activity_wait old_creator_delete_before_cleanup Timeout PgSleep
set +e
psql_cmd -Atqc \
  "DELETE FROM auth.users WHERE id='b0000000-0000-4000-8000-000000000003'" \
  >"$TMP_ROOT/owner-cleanup-after-old-creator-delete.out" 2>&1
OWNER_DELETE_STATUS=$?
set -e
wait "$CREATOR_DELETE_PID"
if ((OWNER_DELETE_STATUS == 0)); then
  echo "Owner cleanup waited through an in-flight old-creator deletion" >&2
  exit 1
fi
grep -q 'group-channel creator deletion is concurrent; retry' \
  "$TMP_ROOT/owner-cleanup-after-old-creator-delete.out"
psql_cmd -Atqc \
  "DELETE FROM auth.users WHERE id='b0000000-0000-4000-8000-000000000003'" \
  >"$TMP_ROOT/owner-cleanup-after-old-creator-retry.out"
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000050'")" != "0" ]] || [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM auth.users WHERE id IN ('a0000000-0000-4000-8000-000000000003','b0000000-0000-4000-8000-000000000003')")" != "0" ]]; then
  echo "Creator-first owner cleanup did not converge to exact deletion" >&2
  exit 1
fi

# Cleanup-first obtains the creator SHARE guard and then pauses in a trigger
# sorted after the serializer. Auth deletion of A waits before touching A's
# membership; B's owner cascade deletes the channel and both calls then commit.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000051' 'a0000000-0000-4000-8000-000000000004' 'Owner cleanup before creator' 'NULL' "'b0000000-0000-4000-8000-000000000004'")" \
  >/dev/null
psql_cmd -c "BEGIN; UPDATE public.channel_members SET role='owner' WHERE channel_id='10000000-0000-4000-8000-000000000051' AND user_id='b0000000-0000-4000-8000-000000000004'; UPDATE public.channel_members SET role='member' WHERE channel_id='10000000-0000-4000-8000-000000000051' AND user_id='a0000000-0000-4000-8000-000000000004'; COMMIT" >/dev/null
PGAPPNAME=owner_cleanup_before_old_creator psql_cmd -Atqc \
  "SET test.pause_guarded_parent_delete_channel='10000000-0000-4000-8000-000000000051'; DELETE FROM auth.users WHERE id='b0000000-0000-4000-8000-000000000004'" \
  >"$TMP_ROOT/owner-cleanup-before-old-creator.out" 2>&1 &
OWNER_DELETE_PID=$!
expect_activity_wait owner_cleanup_before_old_creator Timeout PgSleep
PGAPPNAME=old_creator_delete_after_cleanup psql_cmd -Atqc \
  "DELETE FROM auth.users WHERE id='a0000000-0000-4000-8000-000000000004'" \
  >"$TMP_ROOT/old-creator-delete-after-cleanup.out" 2>&1 &
CREATOR_DELETE_PID=$!
expect_activity_wait old_creator_delete_after_cleanup Lock
wait "$OWNER_DELETE_PID"
wait "$CREATOR_DELETE_PID"
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000051'")" != "0" ]] || [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM auth.users WHERE id IN ('a0000000-0000-4000-8000-000000000004','b0000000-0000-4000-8000-000000000004')")" != "0" ]]; then
  echo "Cleanup-first old-creator deletion did not converge" >&2
  exit 1
fi

# Same creator/owner, Auth first: pause its owner membership cascade before the
# canonical serializer. A direct postgres parent cleanup locks channel/global,
# but its creator NOWAIT guard aborts immediately and Auth deletion wins.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000052' 'a0000000-0000-4000-8000-000000000005' 'Current creator Auth first' 'NULL' "'b0000000-0000-4000-8000-000000000005'")" \
  >/dev/null
PGAPPNAME=current_creator_delete_first psql_cmd -Atqc \
  "SET test.pause_auth_member_delete='10000000-0000-4000-8000-000000000052:a0000000-0000-4000-8000-000000000005'; DELETE FROM auth.users WHERE id='a0000000-0000-4000-8000-000000000005'" \
  >"$TMP_ROOT/current-creator-delete-first.out" 2>&1 &
CREATOR_DELETE_PID=$!
expect_activity_wait current_creator_delete_first Timeout PgSleep
set +e
psql_cmd -Atqc \
  "DELETE FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000052'" \
  >"$TMP_ROOT/parent-cleanup-after-current-creator.out" 2>&1
PARENT_DELETE_STATUS=$?
set -e
wait "$CREATOR_DELETE_PID"
if ((PARENT_DELETE_STATUS == 0)); then
  echo "Parent deletion bypassed the current creator Auth guard" >&2
  exit 1
fi
grep -q 'group-channel creator deletion is concurrent; retry' \
  "$TMP_ROOT/parent-cleanup-after-current-creator.out"
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000052'")" != "0" ]]; then
  echo "Current-creator Auth winner left an ownerless channel" >&2
  exit 1
fi

# Same creator/owner, parent first: the parent serializer pins creator Auth and
# pauses only after doing so. Auth deletion waits at its parent row, then safely
# succeeds after the parent cascade removes the channel and owner membership.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000053' 'a0000000-0000-4000-8000-000000000006' 'Current creator parent first' 'NULL' "'b0000000-0000-4000-8000-000000000006'")" \
  >/dev/null
PGAPPNAME=current_creator_parent_first psql_cmd -Atqc \
  "SET test.pause_guarded_parent_delete_channel='10000000-0000-4000-8000-000000000053'; DELETE FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000053'" \
  >"$TMP_ROOT/current-creator-parent-first.out" 2>&1 &
PARENT_DELETE_PID=$!
expect_activity_wait current_creator_parent_first Timeout PgSleep
PGAPPNAME=current_creator_delete_after_parent psql_cmd -Atqc \
  "DELETE FROM auth.users WHERE id='a0000000-0000-4000-8000-000000000006'" \
  >"$TMP_ROOT/current-creator-delete-after-parent.out" 2>&1 &
CREATOR_DELETE_PID=$!
expect_activity_wait current_creator_delete_after_parent Lock
wait "$PARENT_DELETE_PID"
wait "$CREATOR_DELETE_PID"
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000053'")" != "0" ]] || [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM auth.users WHERE id='a0000000-0000-4000-8000-000000000006'")" != "0" ]]; then
  echo "Parent-first current-creator deletion did not converge" >&2
  exit 1
fi

if grep -q 'deadlock detected' \
  "$TMP_ROOT/dissolve-creator-delete-first.out" \
  "$TMP_ROOT/dissolve-after-creator-delete.out" \
  "$TMP_ROOT/dissolve-before-creator-delete.out" \
  "$TMP_ROOT/creator-delete-after-dissolve.out" \
  "$TMP_ROOT/old-creator-delete-before-cleanup.out" \
  "$TMP_ROOT/owner-cleanup-after-old-creator-delete.out" \
  "$TMP_ROOT/owner-cleanup-before-old-creator.out" \
  "$TMP_ROOT/old-creator-delete-after-cleanup.out" \
  "$TMP_ROOT/current-creator-delete-first.out" \
  "$TMP_ROOT/parent-cleanup-after-current-creator.out" \
  "$TMP_ROOT/current-creator-parent-first.out" \
  "$TMP_ROOT/current-creator-delete-after-parent.out"; then
  echo "Creator Auth/channel cleanup serialization reached 40P01" >&2
  exit 1
fi

# Same-channel owner promotions: the first serializer holder reaches the
# deferred 23514 check; the other fails immediately with the serializer's
# 40001. Neither path can become a PostgreSQL 40P01 deadlock.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000028' '11111111-1111-4111-8111-111111111111' 'Concurrent owner' 'NULL' "'22222222-2222-4222-8222-222222222222','88888888-8888-4888-8888-888888888888'")" \
  >/dev/null
PGAPPNAME=owner_same_first psql_cmd -Atqc \
  "SET test.pause_owner_channel='10000000-0000-4000-8000-000000000028'; UPDATE public.channel_members SET role='owner' WHERE channel_id='10000000-0000-4000-8000-000000000028' AND user_id='22222222-2222-4222-8222-222222222222'" \
  >"$TMP_ROOT/owner-same-first.out" 2>&1 &
FIRST_PID=$!
expect_activity_wait owner_same_first Timeout PgSleep
set +e
psql_cmd -Atqc \
  "UPDATE public.channel_members SET role='owner' WHERE channel_id='10000000-0000-4000-8000-000000000028' AND user_id='88888888-8888-4888-8888-888888888888'" \
  >"$TMP_ROOT/owner-same-second.out" 2>&1
SECOND_STATUS=$?
wait "$FIRST_PID"
FIRST_STATUS=$?
set -e
if ((FIRST_STATUS == 0 || SECOND_STATUS == 0)); then
  echo "Concurrent double-owner mutation unexpectedly committed" >&2
  exit 1
fi
grep -q 'group channel must have exactly one owner' "$TMP_ROOT/owner-same-first.out"
grep -q 'group-channel owner mutation is concurrent; retry' "$TMP_ROOT/owner-same-second.out"
if grep -q 'deadlock detected' "$TMP_ROOT/owner-same-first.out" "$TMP_ROOT/owner-same-second.out"; then
  echo "Same-channel owner serializer reached a deadlock" >&2
  exit 1
fi

# Cross-channel adversary: each transaction first owns a different owner tuple,
# then inserts a new owner into the opposite channel. The try-lock makes one
# transaction release its tuple with 40001, while the winner deterministically
# reaches 23514; neither waits on global while retaining the first tuple.
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000029' '11111111-1111-4111-8111-111111111111' 'Cross owner A' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >/dev/null
psql_cmd -Atqc \
  "$(service_call_sql '10000000-0000-4000-8000-000000000030' '11111111-1111-4111-8111-111111111111' 'Cross owner B' 'NULL' "'22222222-2222-4222-8222-222222222222'")" \
  >/dev/null
PGAPPNAME=owner_cross_a psql_cmd -Atqc \
  "BEGIN; SELECT 1 FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000029' AND role='owner' FOR UPDATE; SELECT pg_catalog.pg_sleep(2); SET test.pause_owner_channel='10000000-0000-4000-8000-000000000030'; INSERT INTO public.channel_members(id,channel_id,user_id,role) VALUES ('10900000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000030','33333333-3333-4333-8333-333333333333','owner'); COMMIT" \
  >"$TMP_ROOT/owner-cross-a.out" 2>&1 &
FIRST_PID=$!
expect_activity_wait owner_cross_a Timeout PgSleep
PGAPPNAME=owner_cross_b psql_cmd -Atqc \
  "BEGIN; SELECT 1 FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000030' AND role='owner' FOR UPDATE; SELECT pg_catalog.pg_sleep(2); SET test.pause_owner_channel='10000000-0000-4000-8000-000000000029'; INSERT INTO public.channel_members(id,channel_id,user_id,role) VALUES ('10900000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000029','88888888-8888-4888-8888-888888888888','owner'); COMMIT" \
  >"$TMP_ROOT/owner-cross-b.out" 2>&1 &
SECOND_PID=$!
expect_activity_wait owner_cross_b Timeout PgSleep
set +e
wait "$FIRST_PID"
FIRST_STATUS=$?
wait "$SECOND_PID"
SECOND_STATUS=$?
set -e
if ((FIRST_STATUS == 0 || SECOND_STATUS == 0)); then
  echo "Cross-channel double-owner mutation unexpectedly committed" >&2
  exit 1
fi
if [[ "$(grep -hE 'group channel must have exactly one owner' "$TMP_ROOT/owner-cross-a.out" "$TMP_ROOT/owner-cross-b.out" | wc -l | tr -d ' ')" != "1" ]] || [[ "$(grep -hE 'group-channel owner mutation is concurrent; retry' "$TMP_ROOT/owner-cross-a.out" "$TMP_ROOT/owner-cross-b.out" | wc -l | tr -d ' ')" != "1" ]]; then
  echo "Cross-channel serializer did not converge to one 23514 and one 40001" >&2
  exit 1
fi
if grep -q 'deadlock detected' "$TMP_ROOT/owner-cross-a.out" "$TMP_ROOT/owner-cross-b.out"; then
  echo "Cross-channel owner serializer reached a deadlock" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.channel_members WHERE channel_id IN ('10000000-0000-4000-8000-000000000029','10000000-0000-4000-8000-000000000030') AND role='owner'")" != "2" ]]; then
  echo "Cross-channel owner rollback did not restore exact owners" >&2
  exit 1
fi

psql_cmd -c "DROP TRIGGER pause_selected_channel_insert ON public.chat_channels; DROP FUNCTION public.pause_selected_channel_insert(); DROP TRIGGER aa_pause_channel_parent_delete ON public.chat_channels; DROP FUNCTION public.pause_channel_parent_delete(); DROP TRIGGER zz_pause_guarded_channel_parent_delete ON public.chat_channels; DROP FUNCTION public.pause_guarded_channel_parent_delete(); DROP TRIGGER pause_selected_channel_member_insert ON public.channel_members; DROP FUNCTION public.pause_selected_channel_member_insert(); DROP TRIGGER aa_pause_auth_member_delete ON public.channel_members; DROP FUNCTION public.pause_auth_member_delete(); DROP TRIGGER zz_pause_serialized_owner_event ON public.channel_members; DROP FUNCTION public.pause_serialized_owner_event()" >/dev/null

# Every channel left by a successful create/replay has a roster and exactly one
# owner; every denied/failed attempt left no empty or ownerless channel.
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels AS channel_row WHERE channel_row.type='group' AND (NOT EXISTS (SELECT 1 FROM public.channel_members AS member WHERE member.channel_id=channel_row.id) OR (SELECT pg_catalog.count(*) FROM public.channel_members AS owner_member WHERE owner_member.channel_id=channel_row.id AND owner_member.role='owner') <> 1)")" != "0" ]]; then
  echo "An empty or ownerless group channel survived" >&2
  exit 1
fi

if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000018'")" != "1" ]] || [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000018'")" != "2" ]]; then
  echo "Same-ID concurrency created duplicate or partial state" >&2
  exit 1
fi

echo "atomic group-channel create PG17 tests passed"
