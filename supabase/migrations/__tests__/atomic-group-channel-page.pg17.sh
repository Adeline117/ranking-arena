#!/usr/bin/env bash

# PostgreSQL 17 proof for atomic group-channel page reads. It owns an isolated
# temporary cluster and never connects to an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729152500_atomic_group_channel_page.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-group-channel-page-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((59000 + ($$ % 2000)))
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

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle text,
  avatar_url text,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean,
  ban_expires_at timestamptz
);
CREATE TABLE public.chat_channels (
  id uuid PRIMARY KEY,
  name text,
  type text NOT NULL CHECK (type IN ('direct', 'group')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  avatar_url text,
  description text,
  conversation_id uuid,
  last_message_at timestamptz,
  last_message_preview text,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.channel_members (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.chat_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  nickname text,
  joined_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (channel_id, user_id)
);
CREATE TABLE public.channel_messages (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.chat_channels(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL,
  media_url text,
  media_type text,
  media_name text,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  reply_to_id uuid REFERENCES public.channel_messages(id) ON DELETE SET NULL
);
CREATE TABLE public.channel_message_reactions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.channel_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji text NOT NULL,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (message_id, user_id, emoji)
);
CREATE TABLE public.channel_message_reads (
  channel_id uuid NOT NULL REFERENCES public.chat_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at timestamptz,
  PRIMARY KEY (channel_id, user_id)
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.chat_channels OWNER TO postgres;
ALTER TABLE public.channel_members OWNER TO postgres;
ALTER TABLE public.channel_messages OWNER TO postgres;
ALTER TABLE public.channel_message_reactions OWNER TO postgres;
ALTER TABLE public.channel_message_reads OWNER TO postgres;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_message_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_profiles,
  public.chat_channels,
  public.channel_members,
  public.channel_messages,
  public.channel_message_reactions,
  public.channel_message_reads
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.user_profiles,
  public.chat_channels,
  public.channel_members,
  public.channel_messages,
  public.channel_message_reactions
  TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.channel_message_reads TO service_role;

CREATE FUNCTION public.mutate_channel_member_atomic(
  p_channel_id uuid,
  p_actor_id uuid,
  p_target_id uuid,
  p_action text,
  p_role text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_count integer := 0;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'channel-membership:channel:' || p_channel_id::text,
      0
    )
  );
  PERFORM 1 FROM auth.users AS auth_user WHERE auth_user.id = p_actor_id;
  IF p_action = 'remove' THEN
    DELETE FROM public.channel_members AS membership
    WHERE membership.channel_id = p_channel_id
      AND membership.user_id = p_target_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    PERFORM pg_catalog.pg_sleep(2);
  END IF;
  RETURN pg_catalog.jsonb_build_object('success', true, 'changed', v_count = 1);
END
$function$;

CREATE FUNCTION public.update_group_channel_metadata_atomic(
  p_channel_id uuid,
  p_actor_id uuid,
  p_name text,
  p_name_present boolean,
  p_avatar_url text,
  p_avatar_url_present boolean,
  p_description text,
  p_description_present boolean
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('channel-membership:channel:' || p_channel_id::text, 0)
  );
  RETURN pg_catalog.jsonb_build_object('success', true);
END
$function$;

CREATE FUNCTION public.send_channel_message_atomic(
  p_channel_id uuid,
  p_sender_id uuid,
  p_content text,
  p_media_url text DEFAULT NULL,
  p_media_type text DEFAULT NULL,
  p_media_name text DEFAULT NULL,
  p_reply_to_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('channel-membership:channel:' || p_channel_id::text, 0)
  );
  RETURN pg_catalog.jsonb_build_object('success', true);
END
$function$;

CREATE FUNCTION public.toggle_channel_message_reaction_atomic(
  p_channel_id uuid,
  p_message_id uuid,
  p_actor_id uuid,
  p_emoji text
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('channel-membership:channel:' || p_channel_id::text, 0)
  );
  RETURN pg_catalog.jsonb_build_object('success', true);
END
$function$;

CREATE FUNCTION public.dissolve_group_channel_atomic(
  p_channel_id uuid,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('channel-membership:channel:' || p_channel_id::text, 0)
  );
  RETURN pg_catalog.jsonb_build_object('success', true);
END
$function$;

ALTER FUNCTION public.mutate_channel_member_atomic(uuid, uuid, uuid, text, text)
  OWNER TO postgres;
ALTER FUNCTION public.update_group_channel_metadata_atomic(
  uuid, uuid, text, boolean, text, boolean, text, boolean
) OWNER TO postgres;
ALTER FUNCTION public.send_channel_message_atomic(
  uuid, uuid, text, text, text, text, uuid
) OWNER TO postgres;
ALTER FUNCTION public.toggle_channel_message_reaction_atomic(uuid, uuid, uuid, text)
  OWNER TO postgres;
ALTER FUNCTION public.dissolve_group_channel_atomic(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.mutate_channel_member_atomic(uuid, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE
  ON FUNCTION public.mutate_channel_member_atomic(uuid, uuid, uuid, text, text)
  TO service_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SELECT public.get_group_channel_page_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001',NULL,50)"
expect_failure "SET ROLE rogue_role; SELECT public.get_group_channel_page_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001',NULL,50)"

psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444'),
  ('55555555-5555-4555-8555-555555555555');
INSERT INTO public.user_profiles(id, handle, avatar_url, is_banned) VALUES
  ('11111111-1111-4111-8111-111111111111', 'member', NULL, false),
  ('22222222-2222-4222-8222-222222222222', 'owner', 'https://example.com/o.png', false),
  ('33333333-3333-4333-8333-333333333333', 'race-member', NULL, false),
  ('44444444-4444-4444-8444-444444444444', 'outsider', NULL, false),
  ('55555555-5555-4555-8555-555555555555', 'banned', NULL, true);
UPDATE public.user_profiles
SET ban_expires_at = 'infinity'::timestamptz
WHERE id = '55555555-5555-4555-8555-555555555555';
INSERT INTO public.chat_channels(
  id, name, type, created_by, avatar_url, description, created_at, updated_at
) VALUES
  (
    '10000000-0000-4000-8000-000000000001', 'proof group', 'group',
    '22222222-2222-4222-8222-222222222222', NULL, 'private',
    '2026-07-28T00:00:00Z', '2026-07-29T00:00:00Z'
  ),
  (
    '10000000-0000-4000-8000-000000000002', NULL, 'direct',
    '22222222-2222-4222-8222-222222222222', NULL, NULL,
    '2026-07-28T00:00:00Z', '2026-07-29T00:00:00Z'
  );
INSERT INTO public.channel_members(channel_id, user_id, role, nickname, joined_at) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    '22222222-2222-4222-8222-222222222222', 'owner', NULL,
    '2026-07-28T00:00:00Z'
  ),
  (
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111', 'member', 'reader',
    '2026-07-28T00:01:00Z'
  ),
  (
    '10000000-0000-4000-8000-000000000001',
    '33333333-3333-4333-8333-333333333333', 'member', NULL,
    '2026-07-28T00:02:00Z'
  ),
  (
    '10000000-0000-4000-8000-000000000001',
    '55555555-5555-4555-8555-555555555555', 'member', NULL,
    '2026-07-28T00:03:00Z'
  );
INSERT INTO public.channel_messages(
  id, channel_id, sender_id, content, created_at
)
SELECT
  ('20000000-0000-4000-8000-' || pg_catalog.lpad(series.value::text, 12, '0'))::uuid,
  '10000000-0000-4000-8000-000000000001'::uuid,
  '22222222-2222-4222-8222-222222222222'::uuid,
  'message ' || series.value::text,
  '2026-07-29T00:00:00Z'::timestamptz
    + pg_catalog.make_interval(mins => series.value)
FROM pg_catalog.generate_series(1, 52) AS series(value);
UPDATE public.channel_messages
SET reply_to_id = '20000000-0000-4000-8000-000000000001'
WHERE id = '20000000-0000-4000-8000-000000000052';
INSERT INTO public.channel_message_reactions(message_id, user_id, emoji) VALUES
  (
    '20000000-0000-4000-8000-000000000052',
    '22222222-2222-4222-8222-222222222222', '👍'
  ),
  (
    '20000000-0000-4000-8000-000000000052',
    '11111111-1111-4111-8111-111111111111', '👍'
  ),
  (
    '20000000-0000-4000-8000-000000000052',
    '22222222-2222-4222-8222-222222222222', '🔥'
  );
SQL

page_proof="$(psql_cmd -AtF '|' -c "
  SET ROLE service_role;
  SET request.jwt.claim.role='service_role';
  WITH result AS (
    SELECT public.get_group_channel_page_atomic(
      '11111111-1111-4111-8111-111111111111',
      '10000000-0000-4000-8000-000000000001',
      NULL,
      50
    ) AS value
  )
  SELECT
    value->>'success',
    value->>'actor_id',
    value->>'channel_id',
    value->'channel'->>'name',
    pg_catalog.jsonb_array_length(value->'members'),
    pg_catalog.jsonb_array_length(value->'messages'),
    value->>'has_more',
    value->>'my_role',
    value->'messages'->0->>'content',
    value->'messages'->49->>'content',
    value->'messages'->49->'reply_preview'->>'content',
    value->'messages'->49->'reactions' @> '[{\"emoji\":\"👍\",\"count\":2,\"mine\":true}]'::jsonb,
    value ? 'read_at'
  FROM result
")"
page_proof="$(printf '%s\n' "$page_proof" | tail -1)"
expected_page='true|11111111-1111-4111-8111-111111111111|10000000-0000-4000-8000-000000000001|proof group|4|50|true|member|message 3|message 52|message 1|t|t'
if [[ "$page_proof" != "$expected_page" ]]; then
  echo "Exact group-channel page evidence was not returned: $page_proof" >&2
  exit 1
fi

if [[ "$(psql_cmd -Atqc "
  SELECT count(*) = 1 AND last_read_at IS NOT NULL
  FROM public.channel_message_reads
  WHERE channel_id = '10000000-0000-4000-8000-000000000001'
    AND user_id = '11111111-1111-4111-8111-111111111111'
  GROUP BY last_read_at
")" != "t" ]]; then
  echo "Successful page read did not write one read marker" >&2
  exit 1
fi

cursor_proof="$(psql_cmd -AtF '|' -c "
  SET ROLE service_role;
  SET request.jwt.claim.role='service_role';
  WITH result AS (
    SELECT public.get_group_channel_page_atomic(
      '11111111-1111-4111-8111-111111111111',
      '10000000-0000-4000-8000-000000000001',
      '2026-07-29T00:03:00Z',
      50
    ) AS value
  )
  SELECT
    pg_catalog.jsonb_array_length(value->'messages'),
    value->>'has_more',
    value->'messages'->0->>'content',
    value->'messages'->1->>'content'
  FROM result
")"
cursor_proof="$(printf '%s\n' "$cursor_proof" | tail -1)"
if [[ "$cursor_proof" != '2|false|message 1|message 2' ]]; then
  echo "Timestamp cursor page was not bounded correctly: $cursor_proof" >&2
  exit 1
fi

nonmember="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.get_group_channel_page_atomic('44444444-4444-4444-8444-444444444444','10000000-0000-4000-8000-000000000001',NULL,50)")"
if [[ "$nonmember" != '{"reason": "MEMBERSHIP_NOT_FOUND", "success": false}' ]]; then
  echo "Non-member group-channel page read was not denied: $nonmember" >&2
  exit 1
fi

direct_denial="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.get_group_channel_page_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000002',NULL,50)")"
if [[ "$direct_denial" != '{"reason": "CHANNEL_NOT_GROUP", "success": false}' ]]; then
  echo "Direct channel entered the group-channel page authority: $direct_denial" >&2
  exit 1
fi

banned_denial="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.get_group_channel_page_atomic('55555555-5555-4555-8555-555555555555','10000000-0000-4000-8000-000000000001',NULL,50)")"
if [[ "$banned_denial" != '{"reason": "ACTOR_UNAVAILABLE", "success": false}' ]]; then
  echo "Unavailable actor entered the group-channel page authority: $banned_denial" >&2
  exit 1
fi

invalid="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.get_group_channel_page_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001',NULL,51)")"
if [[ "$invalid" != '{"reason": "INVALID", "success": false}' ]]; then
  echo "Unbounded group-channel page request did not fail closed: $invalid" >&2
  exit 1
fi

missing="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.get_group_channel_page_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000099',NULL,50)")"
if [[ "$missing" != '{"reason": "CHANNEL_NOT_FOUND", "success": false}' ]]; then
  echo "Missing channel did not fail closed: $missing" >&2
  exit 1
fi

# The canonical member authority removes the actor while holding the exclusive
# membership serializer. The page RPC must wait, see the committed roster, and
# return only an exact denial without creating a read marker.
psql_cmd -c "
  SET ROLE service_role;
  SET request.jwt.claim.role='service_role';
  SELECT public.mutate_channel_member_atomic(
    '10000000-0000-4000-8000-000000000001',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    'remove',
    NULL
  )
" >"$TMP_ROOT/removal.out" 2>&1 &
removal_pid=$!
sleep 0.3
race_result="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.get_group_channel_page_atomic('33333333-3333-4333-8333-333333333333','10000000-0000-4000-8000-000000000001',NULL,50)")"
wait "$removal_pid"
if [[ "$race_result" != '{"reason": "MEMBERSHIP_NOT_FOUND", "success": false}' ]]; then
  echo "Concurrent member removal penetrated group-channel page authority: $race_result" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.channel_message_reads WHERE user_id='33333333-3333-4333-8333-333333333333'")" != '0' ]]; then
  echo "Denied concurrent page read wrote a read marker" >&2
  exit 1
fi

echo "atomic-group-channel-page PG17 tests passed"
