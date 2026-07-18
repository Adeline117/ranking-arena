#!/usr/bin/env bash

# PostgreSQL 17 proof for the existing-channel member-add transaction. It owns
# an isolated temporary cluster and never connects to an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716152647_atomic_existing_channel_member_add.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-channel-member-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((56000 + ($$ % 5000)))
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

  for attempt in {1..50}; do
    if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = '$application_name' AND wait_event_type = '$wait_event_type' $event_predicate")" == "1" ]]; then
      return 0
    fi
    sleep 0.1
  done

  echo "Timed out waiting for $application_name ($wait_event_type ${wait_event:-any})" >&2
  return 1
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

CREATE TABLE public.chat_channels (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('direct', 'group'))
);

CREATE TABLE public.channel_members (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  channel_id uuid NOT NULL
    REFERENCES public.chat_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL
    REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner', 'admin', 'member')),
  UNIQUE (channel_id, user_id)
);
CREATE INDEX channel_members_channel_idx
  ON public.channel_members(channel_id);

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
CREATE INDEX blocked_users_reverse_idx
  ON public.blocked_users(blocked_id);

CREATE TABLE public.user_follows (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  follower_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  following_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  UNIQUE (follower_id, following_id)
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

ALTER TABLE public.chat_channels OWNER TO postgres;
ALTER TABLE public.channel_members OWNER TO postgres;
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.blocked_users OWNER TO postgres;
ALTER TABLE public.user_follows OWNER TO postgres;

ALTER TABLE public.chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocked_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_follows ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.channel_members
  TO service_role;
CREATE POLICY "Service role manages channel members"
  ON public.channel_members
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Production already has these two independent AFTER INSERT side effects.
-- The atomic member-add migration must preserve their exact trigger contracts
-- while rejecting any broader user_follows trigger inventory.
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

CREATE FUNCTION public.serialize_post_audience_block_edge()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_pairs text[] := ARRAY[]::text[];
  v_pair text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND OLD.blocker_id IS NOT NULL
     AND OLD.blocked_id IS NOT NULL
  THEN
    v_pairs := pg_catalog.array_append(
      v_pairs,
      LEAST(OLD.blocker_id::text, OLD.blocked_id::text)
        || ':' || GREATEST(OLD.blocker_id::text, OLD.blocked_id::text)
    );
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND NEW.blocker_id IS NOT NULL
     AND NEW.blocked_id IS NOT NULL
  THEN
    v_pairs := pg_catalog.array_append(
      v_pairs,
      LEAST(NEW.blocker_id::text, NEW.blocked_id::text)
        || ':' || GREATEST(NEW.blocker_id::text, NEW.blocked_id::text)
    );
  END IF;
  FOR v_pair IN
    SELECT DISTINCT affected_pair
    FROM pg_catalog.unnest(v_pairs) AS affected(affected_pair)
    ORDER BY affected_pair
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('post-audience:block:' || v_pair, 0)
    );
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.serialize_post_audience_block_edge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.serialize_post_audience_block_edge()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_serialize_post_audience_block_edge
BEFORE INSERT OR DELETE OR UPDATE OF blocker_id, blocked_id
ON public.blocked_users
FOR EACH ROW
EXECUTE FUNCTION public.serialize_post_audience_block_edge();

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
      RAISE EXCEPTION 'unsupported pair edge';
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

CREATE TRIGGER trg_serialize_dm_block_pair
BEFORE INSERT OR DELETE OR UPDATE OF blocker_id, blocked_id
ON public.blocked_users
FOR EACH ROW
EXECUTE FUNCTION public.serialize_direct_message_pair_edge();

CREATE TRIGGER trg_serialize_dm_follow_pair
BEFORE INSERT OR DELETE OR UPDATE OF follower_id, following_id
ON public.user_follows
FOR EACH ROW
EXECUTE FUNCTION public.serialize_direct_message_pair_edge();
SQL

# The same file must apply twice without changing its authority contract.
psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

# Adversarial replay checks: same-name metadata is not enough. Reject storage,
# ACL, constraint/index, trigger-inventory and overload drift before replacing
# the RPC or normalizing attacker-controlled authority.
psql_cmd -c "ALTER TABLE public.channel_members FORCE ROW LEVEL SECURITY" >/dev/null
expect_migration_failure
psql_cmd -c "ALTER TABLE public.channel_members NO FORCE ROW LEVEL SECURITY" >/dev/null

psql_cmd -c "ALTER TABLE public.channel_members SET UNLOGGED" >/dev/null
expect_migration_failure
psql_cmd -c "ALTER TABLE public.channel_members SET LOGGED" >/dev/null

psql_cmd -c "CREATE RULE rogue_block_insert AS ON INSERT TO public.blocked_users DO INSTEAD NOTHING" >/dev/null
expect_migration_failure
psql_cmd -c "DROP RULE rogue_block_insert ON public.blocked_users" >/dev/null

psql_cmd -c "CREATE TABLE public.rogue_block_child () INHERITS (public.blocked_users)" >/dev/null
expect_migration_failure
psql_cmd -c "DROP TABLE public.rogue_block_child" >/dev/null

psql_cmd -c "GRANT INSERT ON public.channel_members TO authenticated" >/dev/null
expect_migration_failure
psql_cmd -c "REVOKE INSERT ON public.channel_members FROM authenticated" >/dev/null

psql_cmd -c "CREATE UNIQUE INDEX rogue_channel_member_unique ON public.channel_members(user_id) WHERE false" >/dev/null
expect_migration_failure
psql_cmd -c "DROP INDEX public.rogue_channel_member_unique" >/dev/null

psql_cmd -c "ALTER TABLE public.channel_members ADD CONSTRAINT rogue_channel_member_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE NOT VALID" >/dev/null
expect_migration_failure
psql_cmd -c "ALTER TABLE public.channel_members DROP CONSTRAINT rogue_channel_member_fk" >/dev/null

psql_cmd <<'SQL'
CREATE FUNCTION public.rogue_channel_member_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEW;
END
$function$;
CREATE TRIGGER aaa_rogue_channel_member_trigger
BEFORE INSERT ON public.channel_members
FOR EACH ROW EXECUTE FUNCTION public.rogue_channel_member_trigger();
SQL
expect_migration_failure
psql_cmd <<'SQL'
DROP TRIGGER aaa_rogue_channel_member_trigger ON public.channel_members;
DROP FUNCTION public.rogue_channel_member_trigger();
SQL

# The two production follow side effects are allowlisted only by exact trigger
# metadata. A disabled trigger, wrong function, wrong event, or fourth trigger
# must still fail before the RPC is replaced.
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
DROP TRIGGER on_user_follow ON public.user_follows;
CREATE TRIGGER on_user_follow
AFTER UPDATE ON public.user_follows
FOR EACH ROW
EXECUTE FUNCTION public.create_user_follow_notification();
SQL
expect_migration_failure
psql_cmd <<'SQL'
DROP TRIGGER on_user_follow ON public.user_follows;
CREATE TRIGGER on_user_follow
AFTER INSERT ON public.user_follows
FOR EACH ROW
EXECUTE FUNCTION public.create_user_follow_notification();
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

psql_cmd -Atqc "SELECT pg_catalog.pg_get_functiondef('public.serialize_direct_message_pair_edge()'::regprocedure)" >"$TMP_ROOT/pair-function.sql"
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.serialize_direct_message_pair_edge()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
SQL
expect_migration_failure
psql_cmd -f "$TMP_ROOT/pair-function.sql" >/dev/null

psql_cmd -Atqc "SELECT pg_catalog.pg_get_functiondef('public.serialize_post_audience_block_edge()'::regprocedure)" >"$TMP_ROOT/post-block-function.sql"
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.serialize_post_audience_block_edge()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
SQL
expect_migration_failure
psql_cmd -f "$TMP_ROOT/post-block-function.sql" >/dev/null

psql_cmd -c "CREATE FUNCTION public.add_channel_members_atomic(text) RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb'" >/dev/null
expect_migration_failure
psql_cmd -c "DROP FUNCTION public.add_channel_members_atomic(text)" >/dev/null

psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.add_channel_members_atomic(
  p_channel_id uuid,
  p_actor_id uuid,
  p_candidate_ids uuid[]
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'success', true,
    'channel_id', p_channel_id,
    'added', pg_catalog.cardinality(p_candidate_ids)
  )
$function$;
SQL
# Compatible-signature body/metadata drift is converged back to the sealed
# canonical definition on replay; incompatible overloads above remain fatal.
psql_cmd -f "$MIGRATION" >/dev/null
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.strpos(prosrc, 'FROM public.blocked_users AS block_edge') > 0 AND prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql') FROM pg_catalog.pg_proc WHERE oid='public.add_channel_members_atomic(uuid,uuid,uuid[])'::regprocedure")" != "t" ]]; then
  echo "Replay did not restore the canonical atomic member-add body" >&2
  exit 1
fi

psql_cmd <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444'),
  ('55555555-5555-4555-8555-555555555555'),
  ('66666666-6666-4666-8666-666666666666'),
  ('77777777-7777-4777-8777-777777777777'),
  ('88888888-8888-4888-8888-888888888888'),
  ('99999999-9999-4999-8999-999999999999'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff'),
  ('abababab-abab-4bab-8bab-abababababab'),
  ('acacacac-acac-4cac-8cac-acacacacacac'),
  ('adadadad-adad-4dad-8dad-adadadadadad'),
  ('bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc'),
  ('bdbdbdbd-bdbd-4dbd-8dbd-bdbdbdbdbdbd');

INSERT INTO public.user_profiles(
  id, dm_permission, deleted_at, banned_at, is_banned, ban_expires_at
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'all', NULL, NULL, false, NULL),
  ('22222222-2222-4222-8222-222222222222', 'all', NULL, NULL, false, NULL),
  ('33333333-3333-4333-8333-333333333333', 'all', NULL, NULL, false, NULL),
  ('44444444-4444-4444-8444-444444444444', 'none', NULL, NULL, false, NULL),
  ('55555555-5555-4555-8555-555555555555', 'mutual', NULL, NULL, false, NULL),
  ('66666666-6666-4666-8666-666666666666', 'all', pg_catalog.now(), NULL, false, NULL),
  ('77777777-7777-4777-8777-777777777777', 'all', NULL, NULL, false, NULL),
  ('88888888-8888-4888-8888-888888888888', 'all', NULL, NULL, false, NULL),
  ('99999999-9999-4999-8999-999999999999', 'all', NULL, NULL, false, NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'all', NULL, NULL, false, NULL),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'all', NULL, NULL, false, NULL),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'all', NULL, NULL, false, NULL),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'all', NULL, NULL, false, NULL),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'all', NULL, NULL, false, NULL),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'all', NULL, NULL, false, NULL),
  ('abababab-abab-4bab-8bab-abababababab', 'all', NULL, NULL, false, NULL),
  ('acacacac-acac-4cac-8cac-acacacacacac', 'all', NULL, NULL, false, NULL),
  ('adadadad-adad-4dad-8dad-adadadadadad', 'all', NULL, NULL, false, NULL),
  ('bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc', 'all', NULL, NULL, false, NULL),
  ('bdbdbdbd-bdbd-4dbd-8dbd-bdbdbdbdbdbd', 'all', NULL, NULL, false, NULL);

INSERT INTO public.chat_channels(id, type) VALUES
  ('10000000-0000-4000-8000-000000000001', 'group'),
  ('10000000-0000-4000-8000-000000000002', 'group'),
  ('10000000-0000-4000-8000-000000000003', 'direct'),
  ('10000000-0000-4000-8000-000000000004', 'group'),
  ('10000000-0000-4000-8000-000000000005', 'group'),
  ('10000000-0000-4000-8000-000000000006', 'group'),
  ('10000000-0000-4000-8000-000000000007', 'group'),
  ('10000000-0000-4000-8000-000000000008', 'group'),
  ('10000000-0000-4000-8000-000000000009', 'group'),
  ('10000000-0000-4000-8000-000000000010', 'group');

INSERT INTO public.channel_members(channel_id, user_id, role) VALUES
  ('10000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('10000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'admin'),
  ('10000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'member'),
  ('10000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('10000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('10000000-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('10000000-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('10000000-0000-4000-8000-000000000007', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('10000000-0000-4000-8000-000000000008', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('10000000-0000-4000-8000-000000000009', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('10000000-0000-4000-8000-000000000009', 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc', 'member'),
  ('10000000-0000-4000-8000-000000000010', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('10000000-0000-4000-8000-000000000010', 'abababab-abab-4bab-8bab-abababababab', 'member');

DO $test$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.add_channel_members_atomic(
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    ARRAY['33333333-3333-4333-8333-333333333333']::uuid[]
  );
  IF v_result IS DISTINCT FROM pg_catalog.jsonb_build_object(
    'success', true,
    'channel_id', '10000000-0000-4000-8000-000000000001'::uuid,
    'added', 1
  ) THEN
    RAISE EXCEPTION 'unexpected successful acknowledgement: %', v_result;
  END IF;

  v_result := public.add_channel_members_atomic(
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    ARRAY['33333333-3333-4333-8333-333333333333']::uuid[]
  );
  IF v_result ->> 'success' <> 'true' OR v_result ->> 'added' <> '0' THEN
    RAISE EXCEPTION 'idempotent acknowledgement failed: %', v_result;
  END IF;

  v_result := public.add_channel_members_atomic(
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    ARRAY['44444444-4444-4444-8444-444444444444']::uuid[]
  );
  IF v_result ->> 'reason' <> 'PRIVACY_DENIED' THEN
    RAISE EXCEPTION 'none preference was admitted: %', v_result;
  END IF;

  v_result := public.add_channel_members_atomic(
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    ARRAY['55555555-5555-4555-8555-555555555555']::uuid[]
  );
  IF v_result ->> 'reason' <> 'PRIVACY_DENIED' THEN
    RAISE EXCEPTION 'non-mutual candidate was admitted: %', v_result;
  END IF;

  v_result := public.add_channel_members_atomic(
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    ARRAY['66666666-6666-4666-8666-666666666666']::uuid[]
  );
  IF v_result ->> 'reason' <> 'CANDIDATE_UNAVAILABLE' THEN
    RAISE EXCEPTION 'deleted candidate was admitted: %', v_result;
  END IF;

  v_result := public.add_channel_members_atomic(
    '10000000-0000-4000-8000-000000000002',
    '22222222-2222-4222-8222-222222222222',
    ARRAY['33333333-3333-4333-8333-333333333333']::uuid[]
  );
  IF v_result ->> 'reason' <> 'PERMISSION_DENIED' THEN
    RAISE EXCEPTION 'regular member acquired add authority: %', v_result;
  END IF;

  v_result := public.add_channel_members_atomic(
    '10000000-0000-4000-8000-000000000003',
    '11111111-1111-4111-8111-111111111111',
    ARRAY['33333333-3333-4333-8333-333333333333']::uuid[]
  );
  IF v_result ->> 'reason' <> 'CHANNEL_NOT_GROUP' THEN
    RAISE EXCEPTION 'direct channel admitted group membership write: %', v_result;
  END IF;
END
$test$;

INSERT INTO public.user_follows(follower_id, following_id) VALUES
  ('11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555'),
  ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111');

DO $test$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.add_channel_members_atomic(
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    ARRAY['55555555-5555-4555-8555-555555555555']::uuid[]
  );
  IF v_result ->> 'success' <> 'true' OR v_result ->> 'added' <> '1' THEN
    RAISE EXCEPTION 'mutual candidate was denied: %', v_result;
  END IF;
END
$test$;

INSERT INTO public.blocked_users(blocker_id, blocked_id) VALUES
  ('22222222-2222-4222-8222-222222222222', '77777777-7777-4777-8777-777777777777');

DO $test$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.add_channel_members_atomic(
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    ARRAY['77777777-7777-4777-8777-777777777777']::uuid[]
  );
  IF v_result ->> 'reason' <> 'PRIVACY_DENIED' THEN
    RAISE EXCEPTION 'co-member block was bypassed: %', v_result;
  END IF;
END
$test$;

INSERT INTO public.blocked_users(blocker_id, blocked_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');

DO $test$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.add_channel_members_atomic(
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    ARRAY['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']::uuid[]
  );
  IF v_result ->> 'reason' <> 'PRIVACY_DENIED' THEN
    RAISE EXCEPTION 'reverse candidate block was bypassed: %', v_result;
  END IF;

  v_result := public.add_channel_members_atomic(
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    ARRAY[
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    ]::uuid[]
  );
  IF v_result ->> 'reason' <> 'PRIVACY_DENIED' THEN
    RAISE EXCEPTION 'same-batch candidate block was bypassed: %', v_result;
  END IF;
END
$test$;
SQL

expect_failure "SET ROLE authenticated; SELECT public.add_channel_members_atomic('10000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', ARRAY['88888888-8888-4888-8888-888888888888']::uuid[])"
expect_failure "SET ROLE rogue_role; SELECT public.add_channel_members_atomic('10000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', ARRAY['88888888-8888-4888-8888-888888888888']::uuid[])"

# Race A: the add has completed every permission read and is paused at its
# INSERT. A new block must wait on the shared pair lock; it cannot commit in the
# check/write window.
psql_cmd <<'SQL'
CREATE FUNCTION public.test_pause_channel_member_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.user_id = '88888888-8888-4888-8888-888888888888'::uuid THEN
    PERFORM pg_catalog.pg_sleep(3);
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER zz_test_pause_channel_member_insert
BEFORE INSERT ON public.channel_members
FOR EACH ROW EXECUTE FUNCTION public.test_pause_channel_member_insert();
SQL

PGAPPNAME=channel_add_race psql_cmd -Atqc \
  "SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.add_channel_members_atomic('10000000-0000-4000-8000-000000000004','11111111-1111-4111-8111-111111111111',ARRAY['88888888-8888-4888-8888-888888888888']::uuid[])" \
  >"$TMP_ROOT/add-race-a.out" &
ADD_PID=$!
sleep 0.5
PGAPPNAME=channel_block_race psql_cmd -Atqc \
  "INSERT INTO public.blocked_users(blocker_id,blocked_id) VALUES ('11111111-1111-4111-8111-111111111111','88888888-8888-4888-8888-888888888888')" \
  >"$TMP_ROOT/block-race-a.out" &
BLOCK_PID=$!
sleep 0.5

if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE application_name='channel_block_race' AND wait_event_type='Lock' AND wait_event='advisory'")" != "1" ]]; then
  echo "Concurrent block did not wait behind the add transaction pair lock" >&2
  exit 1
fi

wait "$ADD_PID"
wait "$BLOCK_PID"
grep -q '"added": 1' "$TMP_ROOT/add-race-a.out"

psql_cmd <<'SQL'
DROP TRIGGER zz_test_pause_channel_member_insert ON public.channel_members;
DROP FUNCTION public.test_pause_channel_member_insert();
SQL

# Race B: the block owns the pair first and pauses after inserting. The add
# must wait, then observe the committed block and return PRIVACY_DENIED without
# inserting the candidate.
psql_cmd <<'SQL'
CREATE FUNCTION public.test_pause_block_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.blocked_id = '99999999-9999-4999-8999-999999999999'::uuid THEN
    PERFORM pg_catalog.pg_sleep(3);
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER zz_test_pause_block_insert
AFTER INSERT ON public.blocked_users
FOR EACH ROW EXECUTE FUNCTION public.test_pause_block_insert();
SQL

PGAPPNAME=channel_block_first psql_cmd -Atqc \
  "INSERT INTO public.blocked_users(blocker_id,blocked_id) VALUES ('11111111-1111-4111-8111-111111111111','99999999-9999-4999-8999-999999999999')" \
  >"$TMP_ROOT/block-race-b.out" &
BLOCK_PID=$!
sleep 0.5
PGAPPNAME=channel_add_second psql_cmd -Atqc \
  "SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.add_channel_members_atomic('10000000-0000-4000-8000-000000000005','11111111-1111-4111-8111-111111111111',ARRAY['99999999-9999-4999-8999-999999999999']::uuid[])" \
  >"$TMP_ROOT/add-race-b.out" &
ADD_PID=$!
sleep 0.5

if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE application_name='channel_add_second' AND wait_event_type='Lock' AND wait_event='advisory'")" != "1" ]]; then
  echo "Concurrent add did not wait behind the block transaction pair lock" >&2
  exit 1
fi

wait "$BLOCK_PID"
wait "$ADD_PID"
grep -q '"reason": "PRIVACY_DENIED"' "$TMP_ROOT/add-race-b.out"

if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000005' AND user_id='99999999-9999-4999-8999-999999999999'")" != "0" ]]; then
  echo "Candidate crossed a concurrently committed block" >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP TRIGGER zz_test_pause_block_insert ON public.blocked_users;
DROP FUNCTION public.test_pause_block_insert();
SQL

# Race C: Auth hard deletion owns the candidate parent first and cascades a
# pair-serialized block edge while the add starts second. The add must not own
# any child/pair lock while waiting for Auth, must not deadlock, and must fail
# closed without inserting the deleted identity.
psql_cmd <<'SQL'
INSERT INTO public.blocked_users(blocker_id, blocked_id) VALUES (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '11111111-1111-4111-8111-111111111111'
);

CREATE FUNCTION public.test_pause_auth_user_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'::uuid THEN
    PERFORM pg_catalog.pg_sleep(3);
  END IF;
  RETURN OLD;
END
$function$;
CREATE TRIGGER zz_test_pause_auth_user_delete
BEFORE DELETE ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.test_pause_auth_user_delete();
SQL

PGAPPNAME=auth_delete_first psql_cmd -Atqc \
  "DELETE FROM auth.users WHERE id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'" \
  >"$TMP_ROOT/auth-delete-first.out" 2>&1 &
DELETE_PID=$!
expect_activity_wait auth_delete_first Timeout PgSleep

PGAPPNAME=channel_add_after_auth_delete psql_cmd -Atqc \
  "SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.add_channel_members_atomic('10000000-0000-4000-8000-000000000006','11111111-1111-4111-8111-111111111111',ARRAY['dddddddd-dddd-4ddd-8ddd-dddddddddddd']::uuid[])" \
  >"$TMP_ROOT/add-after-auth-delete.out" 2>&1 &
ADD_PID=$!
expect_activity_wait channel_add_after_auth_delete Lock

wait "$DELETE_PID"
wait "$ADD_PID"
grep -q '"reason": "CANDIDATE_UNAVAILABLE"' "$TMP_ROOT/add-after-auth-delete.out"

if [[ "$(psql_cmd -Atqc "SELECT (SELECT pg_catalog.count(*) FROM auth.users WHERE id='dddddddd-dddd-4ddd-8ddd-dddddddddddd') + (SELECT pg_catalog.count(*) FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000006' AND user_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')")" != "0" ]]; then
  echo "Auth-first deletion left or admitted the deleted candidate" >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP TRIGGER zz_test_pause_auth_user_delete ON auth.users;
DROP FUNCTION public.test_pause_auth_user_delete();
SQL

# Race D: the add owns the candidate Auth parent and pauses immediately before
# its child insert. Auth deletion must wait for that parent (not deadlock on a
# child), then cascade every committed membership/profile after the add exits.
psql_cmd <<'SQL'
CREATE FUNCTION public.test_pause_auth_protected_member_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid THEN
    PERFORM pg_catalog.pg_sleep(3);
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER zz_test_pause_auth_protected_member_insert
BEFORE INSERT ON public.channel_members
FOR EACH ROW EXECUTE FUNCTION public.test_pause_auth_protected_member_insert();
SQL

PGAPPNAME=channel_add_before_auth_delete psql_cmd -Atqc \
  "SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.add_channel_members_atomic('10000000-0000-4000-8000-000000000007','11111111-1111-4111-8111-111111111111',ARRAY['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']::uuid[])" \
  >"$TMP_ROOT/add-before-auth-delete.out" 2>&1 &
ADD_PID=$!
expect_activity_wait channel_add_before_auth_delete Timeout PgSleep

PGAPPNAME=auth_delete_second psql_cmd -Atqc \
  "DELETE FROM auth.users WHERE id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'" \
  >"$TMP_ROOT/auth-delete-second.out" 2>&1 &
DELETE_PID=$!
expect_activity_wait auth_delete_second Lock

wait "$ADD_PID"
wait "$DELETE_PID"
grep -q '"added": 1' "$TMP_ROOT/add-before-auth-delete.out"

if [[ "$(psql_cmd -Atqc "SELECT (SELECT pg_catalog.count(*) FROM auth.users WHERE id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') + (SELECT pg_catalog.count(*) FROM public.user_profiles WHERE id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') + (SELECT pg_catalog.count(*) FROM public.channel_members WHERE user_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')")" != "0" ]]; then
  echo "Add-first/Auth-delete-second race left an Auth orphan" >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP TRIGGER zz_test_pause_auth_protected_member_insert
  ON public.channel_members;
DROP FUNCTION public.test_pause_auth_protected_member_insert();
SQL

# Race E: a role update commits after the optimistic roster observation but
# before child locks. The locked re-read must use the new role and deny the
# former owner rather than authorizing from stale state.
PGAPPNAME=role_auth_parent_hold psql_cmd -Atqc \
  "BEGIN; SELECT id FROM auth.users WHERE id='11111111-1111-4111-8111-111111111111' FOR UPDATE; SELECT pg_catalog.pg_sleep(3); COMMIT" \
  >"$TMP_ROOT/role-auth-parent-hold.out" 2>&1 &
HOLD_PID=$!
expect_activity_wait role_auth_parent_hold Timeout PgSleep

PGAPPNAME=role_recheck_add psql_cmd -Atqc \
  "SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.add_channel_members_atomic('10000000-0000-4000-8000-000000000008','11111111-1111-4111-8111-111111111111',ARRAY['ffffffff-ffff-4fff-8fff-ffffffffffff']::uuid[])" \
  >"$TMP_ROOT/role-recheck-add.out" 2>&1 &
ADD_PID=$!
expect_activity_wait role_recheck_add Lock

psql_cmd -c "UPDATE public.channel_members SET role='member' WHERE channel_id='10000000-0000-4000-8000-000000000008' AND user_id='11111111-1111-4111-8111-111111111111'" >/dev/null
wait "$HOLD_PID"
wait "$ADD_PID"
grep -q '"reason": "PERMISSION_DENIED"' "$TMP_ROOT/role-recheck-add.out"

if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000008' AND user_id='ffffffff-ffff-4fff-8fff-ffffffffffff'")" != "0" ]]; then
  echo "Stale owner role authorized a member add" >&2
  exit 1
fi

# Race F: a child DELETE commits in the same observation/lock interval. The
# final roster is a valid subset, so privacy is checked only against remaining
# members; a block from the removed co-member must not be treated as current.
psql_cmd <<'SQL'
INSERT INTO public.blocked_users(blocker_id, blocked_id) VALUES (
  'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc',
  'bdbdbdbd-bdbd-4dbd-8dbd-bdbdbdbdbdbd'
);
SQL

PGAPPNAME=delete_auth_parent_hold psql_cmd -Atqc \
  "BEGIN; SELECT id FROM auth.users WHERE id='11111111-1111-4111-8111-111111111111' FOR UPDATE; SELECT pg_catalog.pg_sleep(3); COMMIT" \
  >"$TMP_ROOT/delete-auth-parent-hold.out" 2>&1 &
HOLD_PID=$!
expect_activity_wait delete_auth_parent_hold Timeout PgSleep

PGAPPNAME=member_delete_recheck_add psql_cmd -Atqc \
  "SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.add_channel_members_atomic('10000000-0000-4000-8000-000000000009','11111111-1111-4111-8111-111111111111',ARRAY['bdbdbdbd-bdbd-4dbd-8dbd-bdbdbdbdbdbd']::uuid[])" \
  >"$TMP_ROOT/member-delete-recheck-add.out" 2>&1 &
ADD_PID=$!
expect_activity_wait member_delete_recheck_add Lock

psql_cmd -c "DELETE FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000009' AND user_id='bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc'" >/dev/null
wait "$HOLD_PID"
wait "$ADD_PID"
grep -q '"added": 1' "$TMP_ROOT/member-delete-recheck-add.out"

if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000009' AND user_id IN ('bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc','bdbdbdbd-bdbd-4dbd-8dbd-bdbdbdbdbdbd')")" != "1" ]]; then
  echo "Concurrent member DELETE was not reconciled into the final roster" >&2
  exit 1
fi

# Race G: changing a child identity can introduce an Auth parent/pair outside
# the optimistic set. It must raise a retryable serialization error rather than
# extending the lock set out of order or checking privacy against stale IDs.
PGAPPNAME=identity_auth_parent_hold psql_cmd -Atqc \
  "BEGIN; SELECT id FROM auth.users WHERE id='11111111-1111-4111-8111-111111111111' FOR UPDATE; SELECT pg_catalog.pg_sleep(3); COMMIT" \
  >"$TMP_ROOT/identity-auth-parent-hold.out" 2>&1 &
HOLD_PID=$!
expect_activity_wait identity_auth_parent_hold Timeout PgSleep

PGAPPNAME=member_identity_recheck_add psql_cmd -Atqc \
  "SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.add_channel_members_atomic('10000000-0000-4000-8000-000000000010','11111111-1111-4111-8111-111111111111',ARRAY['acacacac-acac-4cac-8cac-acacacacacac']::uuid[])" \
  >"$TMP_ROOT/member-identity-recheck-add.out" 2>&1 &
ADD_PID=$!
expect_activity_wait member_identity_recheck_add Lock

psql_cmd -c "UPDATE public.channel_members SET user_id='adadadad-adad-4dad-8dad-adadadadadad' WHERE channel_id='10000000-0000-4000-8000-000000000010' AND user_id='abababab-abab-4bab-8bab-abababababab'" >/dev/null
wait "$HOLD_PID"
if wait "$ADD_PID"; then
  echo "Concurrent member identity rewrite was not rejected" >&2
  exit 1
fi
grep -q 'channel roster identity changed while locking; retry' \
  "$TMP_ROOT/member-identity-recheck-add.out"

if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000010' AND user_id='acacacac-acac-4cac-8cac-acacacacacac'")" != "0" ]]; then
  echo "Serialization conflict still inserted the requested candidate" >&2
  exit 1
fi

echo "atomic existing-channel member add PG17 tests passed"
