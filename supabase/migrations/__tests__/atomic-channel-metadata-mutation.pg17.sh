#!/usr/bin/env bash

# PostgreSQL 17 proof for atomic group-channel metadata updates. It owns an
# isolated temporary cluster and never connects to an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729133904_atomic_channel_metadata_mutation.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-channel-metadata-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((57000 + ($$ % 4000)))
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

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.chat_channels OWNER TO postgres;
ALTER TABLE public.channel_members OWNER TO postgres;
ALTER TABLE public.chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chat_channels, public.channel_members
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.chat_channels TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.channel_members TO service_role;
CREATE POLICY server_channel ON public.chat_channels
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY server_member ON public.channel_members
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

expect_failure "SET ROLE authenticated; SELECT public.update_group_channel_metadata_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','renamed',true,NULL,false,NULL,false)"
expect_failure "SET ROLE rogue_role; SELECT public.update_group_channel_metadata_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','renamed',true,NULL,false,NULL,false)"

psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');
INSERT INTO public.user_profiles(id, is_banned) VALUES
  ('11111111-1111-4111-8111-111111111111', false),
  ('22222222-2222-4222-8222-222222222222', false),
  ('33333333-3333-4333-8333-333333333333', false);
INSERT INTO public.chat_channels(
  id, name, type, created_by, avatar_url, description,
  last_message_at, created_at, updated_at
) VALUES
  (
    '10000000-0000-4000-8000-000000000001', 'before', 'group',
    '22222222-2222-4222-8222-222222222222', NULL, 'old description',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '10000000-0000-4000-8000-000000000002', NULL, 'direct',
    '22222222-2222-4222-8222-222222222222', NULL, NULL,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );
INSERT INTO public.channel_members(channel_id, user_id, role) VALUES
  ('10000000-0000-4000-8000-000000000001',
    '22222222-2222-4222-8222-222222222222', 'owner'),
  ('10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111', 'admin'),
  ('10000000-0000-4000-8000-000000000001',
    '33333333-3333-4333-8333-333333333333', 'member'),
  ('10000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111', 'member');
SQL

result="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.update_group_channel_metadata_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','renamed',true,NULL,false,'new description',true)")"
if [[ "$result" != *'"success": true'* ]] \
  || [[ "$result" != *'"actor_id": "11111111-1111-4111-8111-111111111111"'* ]] \
  || [[ "$result" != *'"changed": true'* ]] \
  || [[ "$result" != *'"applied_fields": ["name", "description"]'* ]] \
  || [[ "$result" != *'"id": "10000000-0000-4000-8000-000000000001"'* ]] \
  || [[ "$result" != *'"name": "renamed"'* ]] \
  || [[ "$result" != *'"description": "new description"'* ]]; then
  echo "Exact metadata acknowledgement was not returned: $result" >&2
  exit 1
fi

idempotent="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.update_group_channel_metadata_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','renamed',true,NULL,false,NULL,false)")"
if [[ "$idempotent" != *'"success": true'* ]] \
  || [[ "$idempotent" != *'"changed": false'* ]] \
  || [[ "$idempotent" != *'"applied_fields": ["name"]'* ]]; then
  echo "Idempotent metadata acknowledgement drifted: $idempotent" >&2
  exit 1
fi

direct_denial="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.update_group_channel_metadata_atomic('10000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','renamed',true,NULL,false,NULL,false)")"
if [[ "$direct_denial" != '{"reason": "CHANNEL_NOT_GROUP", "success": false}' ]]; then
  echo "Direct-channel denial drifted: $direct_denial" >&2
  exit 1
fi

invalid="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.update_group_channel_metadata_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,false,NULL,false,NULL,false)")"
if [[ "$invalid" != '{"reason": "INVALID", "success": false}' ]]; then
  echo "Empty patch did not fail closed: $invalid" >&2
  exit 1
fi

# A direct service writer wins the membership tuple and demotes the admin. The
# metadata RPC must wait, re-read the locked role, deny, and preserve the name.
psql_cmd \
  -c "BEGIN; UPDATE public.channel_members SET role='member' WHERE channel_id='10000000-0000-4000-8000-000000000001' AND user_id='11111111-1111-4111-8111-111111111111'; SELECT pg_catalog.pg_sleep(2); COMMIT" \
  >"$TMP_ROOT/demotion.out" 2>&1 &
demotion_pid=$!
sleep 0.3
race_result="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.update_group_channel_metadata_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','must-not-apply',true,NULL,false,NULL,false)")"
wait "$demotion_pid"
if [[ "$race_result" != '{"reason": "PERMISSION_DENIED", "success": false}' ]]; then
  echo "Concurrent admin demotion penetrated metadata authority: $race_result" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT name FROM public.chat_channels WHERE id='10000000-0000-4000-8000-000000000001'")" != "renamed" ]]; then
  echo "Denied metadata race changed the channel" >&2
  exit 1
fi

echo "atomic-channel-metadata-mutation PG17 tests passed"
