#!/usr/bin/env bash

# PostgreSQL 17 proof for atomic channel-message sends. It owns an isolated
# temporary cluster and never connects to an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729135645_atomic_channel_message_send.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-channel-message-send-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((58000 + ($$ % 3000)))
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
  name text,
  type text NOT NULL CHECK (type IN ('direct', 'group')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  avatar_url text,
  description text,
  conversation_id uuid,
  last_message_at timestamptz,
  last_message_preview text,
  created_at timestamptz,
  updated_at timestamptz
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
  content text NOT NULL DEFAULT '',
  media_url text,
  media_type text CHECK (media_type IN ('image', 'video', 'file')),
  media_name text,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  reply_to_id uuid REFERENCES public.channel_messages(id) ON DELETE SET NULL
);
CREATE TABLE public.channel_message_reads (
  channel_id uuid NOT NULL REFERENCES public.chat_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (channel_id, user_id)
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.chat_channels OWNER TO postgres;
ALTER TABLE public.channel_members OWNER TO postgres;
ALTER TABLE public.channel_messages OWNER TO postgres;
ALTER TABLE public.channel_message_reads OWNER TO postgres;
ALTER TABLE public.chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_message_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chat_channels,
  public.channel_members,
  public.channel_messages,
  public.channel_message_reads
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.chat_channels TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.channel_members TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.channel_messages TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.channel_message_reads TO service_role;
CREATE POLICY server_channel ON public.chat_channels
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY server_member ON public.channel_members
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY server_message ON public.channel_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY server_read ON public.channel_message_reads
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

-- Deliberately preserve the legacy unqualified body. The migration must
-- replace it before the fixed-search-path atomic RPC inserts a message.
CREATE FUNCTION public.update_channel_last_message()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE chat_channels
  SET last_message_at = NEW.created_at,
      last_message_preview = LEFT(NEW.content, 100),
      updated_at = NOW()
  WHERE id = NEW.channel_id;
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_channel_message_update
AFTER INSERT ON public.channel_messages
FOR EACH ROW EXECUTE FUNCTION public.update_channel_last_message();
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SELECT public.send_channel_message_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','blocked',NULL,NULL,NULL,NULL)"
expect_failure "SET ROLE rogue_role; SELECT public.send_channel_message_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','blocked',NULL,NULL,NULL,NULL)"

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
INSERT INTO public.chat_channels(
  id, name, type, created_by, created_at, updated_at
) VALUES
  (
    '10000000-0000-4000-8000-000000000001', 'group one', 'group',
    '22222222-2222-4222-8222-222222222222',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
  ),
  (
    '10000000-0000-4000-8000-000000000002', 'group two', 'group',
    '22222222-2222-4222-8222-222222222222',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
  ),
  (
    '10000000-0000-4000-8000-000000000003', NULL, 'direct',
    '22222222-2222-4222-8222-222222222222',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
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
INSERT INTO public.channel_messages(channel_id, sender_id, content) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    '22222222-2222-4222-8222-222222222222',
    'reply parent'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '22222222-2222-4222-8222-222222222222',
    'cross-channel parent'
  );
SQL

parent_id="$(psql_cmd -Atqc "SELECT id FROM public.channel_messages WHERE content='reply parent'")"
cross_parent_id="$(psql_cmd -Atqc "SELECT id FROM public.channel_messages WHERE content='cross-channel parent'")"

result="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.send_channel_message_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','hello channel',NULL,NULL,NULL,NULL)")"
if [[ "$result" != *'"success": true'* ]] \
  || [[ "$result" != *'"actor_id": "11111111-1111-4111-8111-111111111111"'* ]] \
  || [[ "$result" != *'"channel_id": "10000000-0000-4000-8000-000000000001"'* ]] \
  || [[ "$result" != *'"content": "hello channel"'* ]] \
  || [[ "$result" != *'"reply_author_id": null'* ]] \
  || [[ "$result" != *'"read_at":'* ]]; then
  echo "Exact channel-message acknowledgement was not returned: $result" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT last_message_preview FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000001'")" != "hello channel" ]]; then
  echo "Hardened channel summary trigger did not run" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.channel_message_reads WHERE channel_id='10000000-0000-4000-8000-000000000001' AND user_id='11111111-1111-4111-8111-111111111111'")" != "1" ]]; then
  echo "Atomic send did not advance the sender read marker" >&2
  exit 1
fi

reply_result="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.send_channel_message_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','reply','https://example.com/file.png','image','file.png','$parent_id')")"
if [[ "$reply_result" != *'"success": true'* ]] \
  || [[ "$reply_result" != *'"reply_author_id": "22222222-2222-4222-8222-222222222222"'* ]] \
  || [[ "$reply_result" != *"\"reply_to_id\": \"$parent_id\""* ]] \
  || [[ "$reply_result" != *'"media_type": "image"'* ]]; then
  echo "Bound reply acknowledgement drifted: $reply_result" >&2
  exit 1
fi

cross_denial="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.send_channel_message_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','bad reply',NULL,NULL,NULL,'$cross_parent_id')")"
if [[ "$cross_denial" != '{"reason": "INVALID_REPLY_TARGET", "success": false}' ]]; then
  echo "Cross-channel reply was not denied: $cross_denial" >&2
  exit 1
fi

nonmember="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.send_channel_message_atomic('10000000-0000-4000-8000-000000000001','44444444-4444-4444-8444-444444444444','blocked',NULL,NULL,NULL,NULL)")"
if [[ "$nonmember" != '{"reason": "MEMBERSHIP_NOT_FOUND", "success": false}' ]]; then
  echo "Non-member channel send was not denied: $nonmember" >&2
  exit 1
fi

direct_denial="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.send_channel_message_atomic('10000000-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','blocked',NULL,NULL,NULL,NULL)")"
if [[ "$direct_denial" != '{"reason": "CHANNEL_NOT_GROUP", "success": false}' ]]; then
  echo "Direct-channel send was not denied: $direct_denial" >&2
  exit 1
fi

invalid="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.send_channel_message_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','',NULL,NULL,NULL,NULL)")"
if [[ "$invalid" != '{"reason": "INVALID", "success": false}' ]]; then
  echo "Empty channel-message send did not fail closed: $invalid" >&2
  exit 1
fi

invalid_media="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.send_channel_message_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','media','https://example.com/file.png',NULL,NULL,NULL)")"
if [[ "$invalid_media" != '{"reason": "INVALID", "success": false}' ]]; then
  echo "Incomplete channel-message media did not fail closed: $invalid_media" >&2
  exit 1
fi

# A direct service writer wins the membership tuple and removes the member.
# The atomic send must wait, re-read the locked roster, deny, and insert no row.
before_race_count="$(psql_cmd -Atqc "SELECT count(*) FROM public.channel_messages")"
psql_cmd \
  -c "BEGIN; DELETE FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000001' AND user_id='33333333-3333-4333-8333-333333333333'; SELECT pg_catalog.pg_sleep(2); COMMIT" \
  >"$TMP_ROOT/removal.out" 2>&1 &
removal_pid=$!
sleep 0.3
race_result="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.send_channel_message_atomic('10000000-0000-4000-8000-000000000001','33333333-3333-4333-8333-333333333333','must-not-send',NULL,NULL,NULL,NULL)")"
wait "$removal_pid"
if [[ "$race_result" != '{"reason": "MEMBERSHIP_NOT_FOUND", "success": false}' ]]; then
  echo "Concurrent member removal penetrated channel send authority: $race_result" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.channel_messages")" != "$before_race_count" ]]; then
  echo "Denied channel send race inserted a message" >&2
  exit 1
fi

echo "atomic-channel-message-send PG17 tests passed"
