#!/usr/bin/env bash

# PostgreSQL 17 proof for the pair-serialized direct-message conversation page.
# This owns an isolated temporary cluster and never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729165000_atomic_direct_message_conversation_page.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-dm-page-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((65000 + ($$ % 500)))
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

service_sql() {
  local sql=$1
  psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; $sql"
}

expect_failure() {
  local sql=$1
  if psql_cmd -c "$sql" >"$TMP_ROOT/expected-failure.out" 2>&1; then
    echo "Expected SQL to fail: $sql" >&2
    return 1
  fi
}

assert_scalar() {
  local expected=$1
  local sql=$2
  local actual
  actual="$(psql_cmd -Atqc "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected [$expected], received [$actual] for: $sql" >&2
    return 1
  fi
}

assert_service_scalar() {
  local expected=$1
  local sql=$2
  local actual
  actual="$(service_sql "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected [$expected], received [$actual] for service SQL: $sql" >&2
    return 1
  fi
}

wait_for_query() {
  local pattern=$1
  local attempts=0
  while ((attempts < 300)); do
    if [[ "$(psql_cmd -Atqc "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE '%${pattern}%' AND state = 'active')")" == "t" ]]; then
      return 0
    fi
    attempts=$((attempts + 1))
  done
  echo "Timed out waiting for query pattern: $pattern" >&2
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
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses= -c timezone=UTC" \
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

CREATE FUNCTION public.install_active_authenticated_subject_mutation_barriers()
RETURNS integer LANGUAGE sql AS $function$ SELECT 1 $function$;
CREATE FUNCTION public.assert_active_authenticated_subject_mutation_barriers()
RETURNS integer LANGUAGE sql AS $function$ SELECT 1 $function$;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle text NOT NULL,
  avatar_url text,
  bio text,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.conversations (
  id uuid PRIMARY KEY,
  user1_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user2_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  UNIQUE (user1_id, user2_id),
  CHECK (user1_id < user2_id)
);
CREATE TABLE public.conversation_members (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cleared_before timestamptz,
  UNIQUE (conversation_id, user_id)
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
CREATE TABLE public.direct_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receiver_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL,
  read boolean DEFAULT false,
  read_at timestamptz,
  created_at timestamptz,
  deleted_at timestamptz,
  media_url text,
  media_type text,
  media_name text,
  reply_to_id uuid REFERENCES public.direct_messages(id) ON DELETE SET NULL
);
CREATE TABLE public.message_reactions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.direct_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji text NOT NULL,
  UNIQUE (message_id, user_id, emoji)
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.conversations OWNER TO postgres;
ALTER TABLE public.conversation_members OWNER TO postgres;
ALTER TABLE public.blocked_users OWNER TO postgres;
ALTER TABLE public.user_follows OWNER TO postgres;
ALTER TABLE public.direct_messages OWNER TO postgres;
ALTER TABLE public.message_reactions OWNER TO postgres;

GRANT SELECT ON public.user_profiles, public.conversations,
  public.conversation_members, public.blocked_users, public.user_follows,
  public.direct_messages, public.message_reactions TO service_role;
GRANT INSERT, UPDATE, DELETE ON public.direct_messages,
  public.message_reactions TO service_role;
GRANT SELECT ON public.direct_messages, public.message_reactions,
  public.conversation_members TO authenticated;

CREATE FUNCTION public.serialize_direct_message_pair_edge()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_left uuid;
  v_right uuid;
  v_pair text;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'direct_messages' THEN
      IF TG_OP = 'DELETE' THEN
        v_left := OLD.sender_id;
        v_right := OLD.receiver_id;
      ELSE
        v_left := NEW.sender_id;
        v_right := NEW.receiver_id;
      END IF;
    WHEN 'blocked_users' THEN
      IF TG_OP = 'DELETE' THEN
        v_left := OLD.blocker_id;
        v_right := OLD.blocked_id;
      ELSE
        v_left := NEW.blocker_id;
        v_right := NEW.blocked_id;
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported direct-message pair table';
  END CASE;

  v_pair := LEAST(v_left::text, v_right::text)
    || ':' || GREATEST(v_left::text, v_right::text);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.serialize_direct_message_pair_edge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.serialize_direct_message_pair_edge()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_serialize_dm_message_pair
BEFORE INSERT OR UPDATE OR DELETE ON public.direct_messages
FOR EACH ROW EXECUTE FUNCTION public.serialize_direct_message_pair_edge();

CREATE FUNCTION public.mutate_direct_message_conversation_settings_atomic(
  p_conversation_id uuid,
  p_actor_id uuid,
  p_remark text,
  p_remark_present boolean,
  p_is_muted boolean,
  p_is_muted_present boolean,
  p_is_pinned boolean,
  p_is_pinned_present boolean,
  p_is_blocked boolean,
  p_is_blocked_present boolean,
  p_clear_history boolean
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_left uuid;
  v_right uuid;
  v_now timestamptz := COALESCE(
    NULLIF(pg_catalog.current_setting('test.clear_at', true), '')::timestamptz,
    pg_catalog.statement_timestamp()
  );
BEGIN
  SELECT conversation.user1_id, conversation.user2_id
  INTO STRICT v_left, v_right
  FROM public.conversations AS conversation
  WHERE conversation.id = p_conversation_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'direct-message:pair:' || v_left::text || ':' || v_right::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'direct-message:settings:' || p_conversation_id::text || ':' || p_actor_id::text,
      0
    )
  );
  IF p_clear_history THEN
    INSERT INTO public.conversation_members(conversation_id, user_id, cleared_before)
    VALUES (p_conversation_id, p_actor_id, v_now)
    ON CONFLICT (conversation_id, user_id) DO UPDATE
    SET cleared_before = CASE
      WHEN conversation_members.cleared_before IS NULL
        OR conversation_members.cleared_before < EXCLUDED.cleared_before
      THEN EXCLUDED.cleared_before
      ELSE conversation_members.cleared_before
    END;
  END IF;
  RETURN pg_catalog.jsonb_build_object('success', true, 'cleared_before', v_now);
END
$function$;
ALTER FUNCTION public.mutate_direct_message_conversation_settings_atomic(
  uuid, uuid, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mutate_direct_message_conversation_settings_atomic(
  uuid, uuid, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mutate_direct_message_conversation_settings_atomic(
  uuid, uuid, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean
) TO service_role;

CREATE FUNCTION public.send_direct_message_atomic(
  uuid, uuid, text, text, text, text, uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
AS $function$
BEGIN
  PERFORM pg_catalog.hashtextextended('direct-message:pair:', 0);
  RETURN '{}'::jsonb;
END
$function$;
CREATE FUNCTION public.delete_direct_message_atomic(uuid, uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
AS $function$
BEGIN
  PERFORM pg_catalog.hashtextextended('direct-message:pair:', 0);
  RETURN '{}'::jsonb;
END
$function$;
CREATE FUNCTION public.toggle_direct_message_reaction_atomic(uuid, uuid, uuid, text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
AS $function$
BEGIN
  PERFORM pg_catalog.hashtextextended('direct-message:pair:', 0);
  RETURN '{}'::jsonb;
END
$function$;
ALTER FUNCTION public.send_direct_message_atomic(uuid,uuid,text,text,text,text,uuid)
  OWNER TO postgres;
ALTER FUNCTION public.delete_direct_message_atomic(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.toggle_direct_message_reaction_atomic(uuid,uuid,uuid,text)
  OWNER TO postgres;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.conversation_members FROM PUBLIC, anon, authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.direct_messages, public.message_reactions
  FROM PUBLIC, anon, authenticated;
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,NULL,50)"
expect_failure "SET ROLE rogue_role; SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,NULL,50)"

psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('12222222-2222-4222-8222-222222222222'),
  ('13333333-3333-4333-8333-333333333333'),
  ('21111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('31111111-1111-4111-8111-111111111111'),
  ('32222222-2222-4222-8222-222222222222');

INSERT INTO public.user_profiles(id, handle, avatar_url, bio) VALUES
  ('11111111-1111-4111-8111-111111111111','actor','https://img/actor','actor bio'),
  ('12222222-2222-4222-8222-222222222222','other','https://img/other','other bio'),
  ('13333333-3333-4333-8333-333333333333','outsider',NULL,NULL),
  ('21111111-1111-4111-8111-111111111111','delete-actor',NULL,NULL),
  ('22222222-2222-4222-8222-222222222222','delete-other',NULL,NULL),
  ('31111111-1111-4111-8111-111111111111','leave-actor',NULL,NULL),
  ('32222222-2222-4222-8222-222222222222','leave-other',NULL,NULL);

INSERT INTO public.conversations(id, user1_id, user2_id) VALUES
  ('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','12222222-2222-4222-8222-222222222222'),
  ('a0000000-0000-4000-8000-000000000002','21111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'),
  ('a0000000-0000-4000-8000-000000000003','31111111-1111-4111-8111-111111111111','32222222-2222-4222-8222-222222222222');

INSERT INTO public.conversation_members(
  conversation_id, user_id, cleared_before
) VALUES (
  'a0000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '2026-07-29T10:00:30Z'
);

INSERT INTO public.direct_messages(
  id, conversation_id, sender_id, receiver_id, content, read, read_at,
  created_at, deleted_at, media_url, media_type, media_name, reply_to_id
) VALUES
  ('b0000000-0000-4000-8000-000000000100','a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','12222222-2222-4222-8222-222222222222','cleared parent',true,'2026-07-29T10:00:01Z','2026-07-29T10:00:00Z',NULL,NULL,NULL,NULL,NULL),
  ('b0000000-0000-4000-8000-000000000150','a0000000-0000-4000-8000-000000000001','12222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','live parent',false,NULL,'2026-07-29T10:01:00Z',NULL,NULL,NULL,NULL,NULL),
  ('b0000000-0000-4000-8000-000000000201','a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','12222222-2222-4222-8222-222222222222','tie one',false,NULL,'2026-07-29T10:02:00Z',NULL,NULL,NULL,NULL,NULL),
  ('b0000000-0000-4000-8000-000000000202','a0000000-0000-4000-8000-000000000001','12222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','tie two',false,NULL,'2026-07-29T10:02:00Z',NULL,'https://img/file','image','file.png','b0000000-0000-4000-8000-000000000150'),
  ('b0000000-0000-4000-8000-000000000203','a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','12222222-2222-4222-8222-222222222222','tie three',false,NULL,'2026-07-29T10:02:00Z',NULL,NULL,NULL,NULL,'b0000000-0000-4000-8000-000000000100'),
  ('b0000000-0000-4000-8000-000000000204','a0000000-0000-4000-8000-000000000001','12222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','deleted',false,NULL,'2026-07-29T10:03:00Z','2026-07-29T10:03:01Z',NULL,NULL,NULL,NULL);

INSERT INTO public.message_reactions(message_id, user_id, emoji) VALUES
  ('b0000000-0000-4000-8000-000000000202','11111111-1111-4111-8111-111111111111','x'),
  ('b0000000-0000-4000-8000-000000000202','12222222-2222-4222-8222-222222222222','x'),
  ('b0000000-0000-4000-8000-000000000202','12222222-2222-4222-8222-222222222222','y');
SQL

# Strict input and participant admission fail closed.
assert_service_scalar 'INVALID' "SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','2026-07-29T10:02:00Z',NULL,2)->>'reason'"
assert_service_scalar 'INVALID' "SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,NULL,0)->>'reason'"
assert_service_scalar 'NOT_FOUND' "SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','13333333-3333-4333-8333-333333333333',NULL,NULL,2)->>'reason'"

# Page one proves stable tie ordering, strict next cursor, clear/delete filters,
# live-only reply previews, deterministic reactions, and other-profile evidence.
assert_service_scalar '2|true|b0000000-0000-4000-8000-000000000202|b0000000-0000-4000-8000-000000000203|b0000000-0000-4000-8000-000000000202|other|2026-07-29T10:00:30+00:00' "SELECT jsonb_array_length(r->'messages') || '|' || (r->>'has_more') || '|' || (r#>>'{messages,0,id}') || '|' || (r#>>'{messages,1,id}') || '|' || (r#>>'{next_cursor,before_id}') || '|' || (r#>>'{other_user,handle}') || '|' || (r->>'cleared_before') FROM (SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,NULL,2) AS r) AS result"
assert_service_scalar 'live parent|true|x|2|true|y|1|false' "SELECT (r#>>'{messages,0,reply_preview,content}') || '|' || ((r#>'{messages,1,reply_preview}') = 'null'::jsonb)::text || '|' || (r#>>'{messages,0,reactions,0,emoji}') || '|' || (r#>>'{messages,0,reactions,0,count}') || '|' || (r#>>'{messages,0,reactions,0,mine}') || '|' || (r#>>'{messages,0,reactions,1,emoji}') || '|' || (r#>>'{messages,0,reactions,1,count}') || '|' || (r#>>'{messages,0,reactions,1,mine}') FROM (SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,NULL,2) AS r) AS result"

# Page two uses both cursor fields and neither skips nor duplicates tied rows.
assert_service_scalar '2|false|b0000000-0000-4000-8000-000000000150|b0000000-0000-4000-8000-000000000201|true' "SELECT jsonb_array_length(r->'messages') || '|' || (r->>'has_more') || '|' || (r#>>'{messages,0,id}') || '|' || (r#>>'{messages,1,id}') || '|' || ((r->'next_cursor') = 'null'::jsonb)::text FROM (SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','2026-07-29T10:02:00Z','b0000000-0000-4000-8000-000000000202',2) AS r) AS result"
assert_service_scalar '0' "WITH page_one AS (SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,NULL,2) AS r), page_two AS (SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','2026-07-29T10:02:00Z','b0000000-0000-4000-8000-000000000202',2) AS r) SELECT count(*) FROM (SELECT jsonb_array_elements(page_one.r->'messages')->>'id' AS id FROM page_one INTERSECT SELECT jsonb_array_elements(page_two.r->'messages')->>'id' AS id FROM page_two) AS duplicate"

# Active-state admission is derived from locked profiles.
psql_cmd -qc "UPDATE public.user_profiles SET deleted_at='2026-07-29T11:00:00Z' WHERE id='11111111-1111-4111-8111-111111111111'"
assert_service_scalar 'ACTOR_UNAVAILABLE' "SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,NULL,2)->>'reason'"
psql_cmd -qc "UPDATE public.user_profiles SET deleted_at=NULL WHERE id='11111111-1111-4111-8111-111111111111'; UPDATE public.user_profiles SET is_banned=true WHERE id='12222222-2222-4222-8222-222222222222'"
assert_service_scalar 'PARTICIPANT_UNAVAILABLE' "SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,NULL,2)->>'reason'"
psql_cmd -qc "UPDATE public.user_profiles SET is_banned=false WHERE id='12222222-2222-4222-8222-222222222222'"

# A clear-history transaction that wins the pair lock is reflected atomically;
# no message at or before its committed database timestamp crosses the page.
psql_cmd -qc "INSERT INTO public.direct_messages(id,conversation_id,sender_id,receiver_id,content,created_at) VALUES ('b0000000-0000-4000-8000-000000000300','a0000000-0000-4000-8000-000000000001','12222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','after clear','2026-07-29T10:03:00Z')"
psql_cmd >"$TMP_ROOT/clear-owner.out" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SET test.clear_at='2026-07-29T10:02:30Z';
SELECT public.mutate_direct_message_conversation_settings_atomic(
  'a0000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  NULL, false, NULL, false, NULL, false, NULL, false, true
);
SELECT pg_catalog.pg_sleep(1) /* dm_page_clear_hold */;
COMMIT;
SQL
clear_pid=$!
wait_for_query 'dm_page_clear_hold'
assert_service_scalar '2026-07-29T10:02:30+00:00|1|b0000000-0000-4000-8000-000000000300' "SELECT (r->>'cleared_before') || '|' || jsonb_array_length(r->'messages') || '|' || (r#>>'{messages,0,id}') FROM (SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,NULL,100) AS r) AS result"
wait "$clear_pid"

# A message plus reaction commit is either wholly before or after the page.
psql_cmd >"$TMP_ROOT/insert-owner.out" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
INSERT INTO public.direct_messages(
  id, conversation_id, sender_id, receiver_id, content, created_at
) VALUES (
  'b0000000-0000-4000-8000-000000000301',
  'a0000000-0000-4000-8000-000000000001',
  '12222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'committed together',
  '2026-07-29T10:04:00Z'
);
INSERT INTO public.message_reactions(message_id, user_id, emoji) VALUES (
  'b0000000-0000-4000-8000-000000000301',
  '12222222-2222-4222-8222-222222222222',
  'z'
);
SELECT pg_catalog.pg_sleep(1) /* dm_page_insert_hold */;
COMMIT;
SQL
insert_pid=$!
wait_for_query 'dm_page_insert_hold'
assert_service_scalar '2|b0000000-0000-4000-8000-000000000301|z|1|false' "SELECT jsonb_array_length(r->'messages') || '|' || (r#>>'{messages,1,id}') || '|' || (r#>>'{messages,1,reactions,0,emoji}') || '|' || (r#>>'{messages,1,reactions,0,count}') || '|' || (r#>>'{messages,1,reactions,0,mine}') FROM (SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,NULL,100) AS r) AS result"
wait "$insert_pid"

# A soft delete that owns the pair lock cannot leave a deleted row in a page.
psql_cmd >"$TMP_ROOT/delete-message-owner.out" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
UPDATE public.direct_messages
SET deleted_at = '2026-07-29T10:05:00Z'
WHERE id = 'b0000000-0000-4000-8000-000000000301';
SELECT pg_catalog.pg_sleep(1) /* dm_page_message_delete_hold */;
COMMIT;
SQL
delete_message_pid=$!
wait_for_query 'dm_page_message_delete_hold'
assert_service_scalar '1|b0000000-0000-4000-8000-000000000300' "SELECT jsonb_array_length(r->'messages') || '|' || (r#>>'{messages,0,id}') FROM (SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,NULL,100) AS r) AS result"
wait "$delete_message_pid"

# Lifecycle-owned ban wins before page admission.
psql_cmd >"$TMP_ROOT/ban-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:12222222-2222-4222-8222-222222222222',
    0
  )
);
UPDATE public.user_profiles
SET is_banned = true
WHERE id = '12222222-2222-4222-8222-222222222222';
SELECT pg_catalog.pg_sleep(1) /* dm_page_ban_hold */;
COMMIT;
SQL
ban_pid=$!
wait_for_query 'dm_page_ban_hold'
assert_service_scalar 'PARTICIPANT_UNAVAILABLE' "SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,NULL,100)->>'reason'"
wait "$ban_pid"

# Hard deletion and conversation leave cannot return a stale authorized page.
psql_cmd >"$TMP_ROOT/account-delete-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:22222222-2222-4222-8222-222222222222',
    0
  )
);
DELETE FROM auth.users
WHERE id = '22222222-2222-4222-8222-222222222222';
SELECT pg_catalog.pg_sleep(1) /* dm_page_account_delete_hold */;
COMMIT;
SQL
account_delete_pid=$!
wait_for_query 'dm_page_account_delete_hold'
assert_service_scalar 'PARTICIPANT_UNAVAILABLE' "SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000002','21111111-1111-4111-8111-111111111111',NULL,NULL,100)->>'reason'"
wait "$account_delete_pid"

psql_cmd >"$TMP_ROOT/conversation-delete-owner.out" 2>&1 <<'SQL' &
BEGIN;
DELETE FROM public.conversations
WHERE id = 'a0000000-0000-4000-8000-000000000003';
SELECT pg_catalog.pg_sleep(1) /* dm_page_conversation_delete_hold */;
COMMIT;
SQL
conversation_delete_pid=$!
wait_for_query 'dm_page_conversation_delete_hold'
assert_service_scalar 'NOT_FOUND' "SELECT public.get_direct_message_conversation_page_atomic('a0000000-0000-4000-8000-000000000003','31111111-1111-4111-8111-111111111111',NULL,NULL,100)->>'reason'"
wait "$conversation_delete_pid"

echo "atomic direct-message conversation-page PostgreSQL 17 checks passed"
