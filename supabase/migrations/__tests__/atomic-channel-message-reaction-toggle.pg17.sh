#!/usr/bin/env bash

# PostgreSQL 17 proof for atomic channel-message reaction toggles. It owns an
# isolated temporary cluster and never connects to an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729141050_atomic_channel_message_reaction_toggle.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-channel-reaction-pg17.XXXXXX)"
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
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean,
  ban_expires_at timestamptz
);
CREATE TABLE public.chat_channels (
  id uuid PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('direct', 'group')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE TABLE public.channel_members (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.chat_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  UNIQUE (channel_id, user_id)
);
CREATE TABLE public.channel_messages (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.chat_channels(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL
);
CREATE TABLE public.channel_message_reactions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.channel_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK (pg_catalog.char_length(emoji) BETWEEN 1 AND 10),
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (message_id, user_id, emoji)
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.chat_channels OWNER TO postgres;
ALTER TABLE public.channel_members OWNER TO postgres;
ALTER TABLE public.channel_messages OWNER TO postgres;
ALTER TABLE public.channel_message_reactions OWNER TO postgres;
ALTER TABLE public.chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_message_reactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chat_channels,
  public.channel_members,
  public.channel_messages,
  public.channel_message_reactions
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.chat_channels TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.channel_members TO service_role;
GRANT SELECT ON TABLE public.channel_messages TO service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.channel_message_reactions TO service_role;
CREATE POLICY server_channel ON public.chat_channels
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY server_member ON public.channel_members
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY server_message ON public.channel_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY server_reaction ON public.channel_message_reactions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

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
  PERFORM 1
  FROM public.channel_members AS membership
  WHERE membership.channel_id = p_channel_id
    AND membership.user_id = p_target_id;
  RETURN pg_catalog.jsonb_build_object(
    'success', false,
    'reason', p_action || COALESCE(p_role, '')
  );
END
$function$;
ALTER FUNCTION public.mutate_channel_member_atomic(uuid, uuid, uuid, text, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mutate_channel_member_atomic(uuid, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE
  ON FUNCTION public.mutate_channel_member_atomic(uuid, uuid, uuid, text, text)
  TO service_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SELECT public.toggle_channel_message_reaction_atomic('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','🔥')"
expect_failure "SET ROLE rogue_role; SELECT public.toggle_channel_message_reaction_atomic('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','🔥')"

psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444');
INSERT INTO public.user_profiles(id, is_banned) VALUES
  ('11111111-1111-4111-8111-111111111111', false),
  ('22222222-2222-4222-8222-222222222222', false),
  ('33333333-3333-4333-8333-333333333333', false),
  ('44444444-4444-4444-8444-444444444444', false);
INSERT INTO public.chat_channels(id, type, created_by) VALUES
  (
    '10000000-0000-4000-8000-000000000001', 'group',
    '22222222-2222-4222-8222-222222222222'
  ),
  (
    '10000000-0000-4000-8000-000000000002', 'group',
    '22222222-2222-4222-8222-222222222222'
  ),
  (
    '10000000-0000-4000-8000-000000000003', 'direct',
    '22222222-2222-4222-8222-222222222222'
  );
INSERT INTO public.channel_members(channel_id, user_id, role) VALUES
  ('10000000-0000-4000-8000-000000000001',
    '22222222-2222-4222-8222-222222222222', 'owner'),
  ('10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111', 'member'),
  ('10000000-0000-4000-8000-000000000001',
    '33333333-3333-4333-8333-333333333333', 'member'),
  ('10000000-0000-4000-8000-000000000002',
    '22222222-2222-4222-8222-222222222222', 'owner'),
  ('10000000-0000-4000-8000-000000000003',
    '11111111-1111-4111-8111-111111111111', 'member');
INSERT INTO public.channel_messages(id, channel_id, sender_id, content) VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '22222222-2222-4222-8222-222222222222',
    'parent message preview'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    '22222222-2222-4222-8222-222222222222',
    'cross-channel message'
  );
INSERT INTO public.channel_message_reactions(message_id, user_id, emoji) VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    '22222222-2222-4222-8222-222222222222',
    '👍'
  );
SQL

added="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.toggle_channel_message_reaction_atomic('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','🔥')")"
if [[ "$added" != *'"success": true'* ]] \
  || [[ "$added" != *'"action": "added"'* ]] \
  || [[ "$added" != *'"changed": true'* ]] \
  || [[ "$added" != *'"actor_id": "11111111-1111-4111-8111-111111111111"'* ]] \
  || [[ "$added" != *'"channel_id": "10000000-0000-4000-8000-000000000001"'* ]] \
  || [[ "$added" != *'"message_id": "20000000-0000-4000-8000-000000000001"'* ]] \
  || [[ "$added" != *'"message_author_id": "22222222-2222-4222-8222-222222222222"'* ]] \
  || [[ "$added" != *'"message_preview": "parent message preview"'* ]] \
  || [[ "$added" != *'"👍": 1'* ]] \
  || [[ "$added" != *'"🔥": 1'* ]] \
  || [[ "$added" != *'"user_emojis": ["🔥"]'* ]]; then
  echo "Exact added reaction acknowledgement was not returned: $added" >&2
  exit 1
fi

removed="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.toggle_channel_message_reaction_atomic('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','🔥')")"
if [[ "$removed" != *'"success": true'* ]] \
  || [[ "$removed" != *'"action": "removed"'* ]] \
  || [[ "$removed" != *'"👍": 1'* ]] \
  || [[ "$removed" == *'"🔥":'* ]] \
  || [[ "$removed" != *'"user_emojis": []'* ]]; then
  echo "Exact removed reaction acknowledgement was not returned: $removed" >&2
  exit 1
fi

wrong_message="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.toggle_channel_message_reaction_atomic('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','🔥')")"
if [[ "$wrong_message" != '{"reason": "MESSAGE_NOT_FOUND", "success": false}' ]]; then
  echo "Cross-channel reaction was not denied: $wrong_message" >&2
  exit 1
fi

nonmember="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.toggle_channel_message_reaction_atomic('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','44444444-4444-4444-8444-444444444444','🔥')")"
if [[ "$nonmember" != '{"reason": "MEMBERSHIP_NOT_FOUND", "success": false}' ]]; then
  echo "Non-member reaction was not denied: $nonmember" >&2
  exit 1
fi

direct_denial="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.toggle_channel_message_reaction_atomic('10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','🔥')")"
if [[ "$direct_denial" != '{"reason": "CHANNEL_NOT_GROUP", "success": false}' ]]; then
  echo "Direct-channel reaction was not denied: $direct_denial" >&2
  exit 1
fi

invalid="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.toggle_channel_message_reaction_atomic('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','💣')")"
if [[ "$invalid" != '{"reason": "INVALID", "success": false}' ]]; then
  echo "Unknown reaction emoji did not fail closed: $invalid" >&2
  exit 1
fi

# A direct service writer removes the member first. The atomic toggle must
# wait, derive membership from the post-delete roster, deny, and write no row.
before_race_count="$(psql_cmd -Atqc "SELECT count(*) FROM public.channel_message_reactions")"
psql_cmd \
  -c "BEGIN; DELETE FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000001' AND user_id='33333333-3333-4333-8333-333333333333'; SELECT pg_catalog.pg_sleep(2); COMMIT" \
  >"$TMP_ROOT/removal.out" 2>&1 &
removal_pid=$!
sleep 0.3
race_result="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.toggle_channel_message_reaction_atomic('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','33333333-3333-4333-8333-333333333333','🔥')")"
wait "$removal_pid"
if [[ "$race_result" != '{"reason": "MEMBERSHIP_NOT_FOUND", "success": false}' ]]; then
  echo "Concurrent member removal penetrated reaction authority: $race_result" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.channel_message_reactions")" != "$before_race_count" ]]; then
  echo "Denied reaction race changed reaction data" >&2
  exit 1
fi

echo "atomic-channel-message-reaction-toggle PG17 tests passed"
