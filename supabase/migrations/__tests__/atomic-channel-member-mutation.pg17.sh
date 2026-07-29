#!/usr/bin/env bash

# PostgreSQL 17 proof for the channel-member mutation transaction. It owns an
# isolated temporary cluster and never connects to an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729131858_atomic_channel_member_mutation.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-channel-member-mutation-pg17.XXXXXX)"
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

CREATE TABLE public.chat_channels (
  id uuid PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('direct', 'group')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
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

ALTER TABLE auth.users OWNER TO postgres;
ALTER TABLE public.chat_channels OWNER TO postgres;
ALTER TABLE public.channel_members OWNER TO postgres;

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

CREATE FUNCTION public.serialize_group_channel_owner_event()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF NOT (
    (TG_OP IN ('UPDATE', 'DELETE') AND OLD.role = 'owner')
    OR (TG_OP IN ('INSERT', 'UPDATE') AND NEW.role = 'owner')
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'owner mutation is concurrent';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.serialize_group_channel_owner_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.serialize_group_channel_owner_event()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.enforce_group_channel_owner_count()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_channel_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.channel_id ELSE NEW.channel_id END;
  v_owner_count integer;
BEGIN
  IF NOT (
    (TG_OP IN ('UPDATE', 'DELETE') AND OLD.role = 'owner')
    OR (TG_OP IN ('INSERT', 'UPDATE') AND NEW.role = 'owner')
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_owner_count
  FROM public.channel_members AS membership
  WHERE membership.channel_id = v_channel_id
    AND membership.role = 'owner';
  IF v_owner_count <> 1 THEN
    RAISE EXCEPTION 'group channel must have exactly one owner';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.enforce_group_channel_owner_count() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_group_channel_owner_count()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_serialize_group_channel_owner_event
BEFORE INSERT OR DELETE OR UPDATE OF role, channel_id, user_id
ON public.channel_members
FOR EACH ROW
EXECUTE FUNCTION public.serialize_group_channel_owner_event();
CREATE CONSTRAINT TRIGGER trg_enforce_group_channel_owner_count
AFTER INSERT OR DELETE OR UPDATE OF role, channel_id, user_id
ON public.channel_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.enforce_group_channel_owner_count();

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
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'channel-membership:channel:' || p_channel_id::text,
      0
    )
  );
  RETURN pg_catalog.jsonb_build_object('success', true, 'added', 0);
END
$function$;
ALTER FUNCTION public.add_channel_members_atomic(uuid, uuid, uuid[])
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.add_channel_members_atomic(uuid, uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_channel_members_atomic(uuid, uuid, uuid[])
  TO service_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SELECT public.mutate_channel_member_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','remove',NULL)"
expect_failure "SET ROLE rogue_role; SELECT public.mutate_channel_member_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','remove',NULL)"

psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444'),
  ('55555555-5555-4555-8555-555555555555');
INSERT INTO public.chat_channels(id, type, created_by) VALUES
  ('10000000-0000-4000-8000-000000000001', 'group',
    '11111111-1111-4111-8111-111111111111'),
  ('10000000-0000-4000-8000-000000000002', 'direct',
    '11111111-1111-4111-8111-111111111111');
INSERT INTO public.channel_members(channel_id, user_id, role) VALUES
  ('10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111', 'owner'),
  ('10000000-0000-4000-8000-000000000001',
    '22222222-2222-4222-8222-222222222222', 'admin'),
  ('10000000-0000-4000-8000-000000000001',
    '33333333-3333-4333-8333-333333333333', 'admin'),
  ('10000000-0000-4000-8000-000000000001',
    '44444444-4444-4444-8444-444444444444', 'member'),
  ('10000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111', 'member');
SQL

result="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.mutate_channel_member_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444','set_role','admin')")"
if [[ "$result" != *'"success": true'* ]] \
  || [[ "$result" != *'"channel_id": "10000000-0000-4000-8000-000000000001"'* ]] \
  || [[ "$result" != *'"actor_id": "11111111-1111-4111-8111-111111111111"'* ]] \
  || [[ "$result" != *'"target_id": "44444444-4444-4444-8444-444444444444"'* ]] \
  || [[ "$result" != *'"action": "set_role"'* ]] \
  || [[ "$result" != *'"changed": true'* ]] \
  || [[ "$result" != *'"role": "admin"'* ]]; then
  echo "Exact role-change acknowledgement was not returned: $result" >&2
  exit 1
fi

idempotent="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.mutate_channel_member_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444','set_role','admin')")"
if [[ "$idempotent" != *'"changed": false'* ]]; then
  echo "Same-role mutation was not acknowledged as idempotent: $idempotent" >&2
  exit 1
fi

peer_denial="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.mutate_channel_member_atomic('10000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','remove',NULL)")"
if [[ "$peer_denial" != '{"reason": "PEER_ADMIN_FORBIDDEN", "success": false}' ]]; then
  echo "Admin peer-removal denial drifted: $peer_denial" >&2
  exit 1
fi

owner_leave="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.mutate_channel_member_atomic('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','leave',NULL)")"
if [[ "$owner_leave" != '{"reason": "OWNER_FORBIDDEN", "success": false}' ]]; then
  echo "Owner leave denial drifted: $owner_leave" >&2
  exit 1
fi

direct_denial="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.mutate_channel_member_atomic('10000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','leave',NULL)")"
if [[ "$direct_denial" != '{"reason": "CHANNEL_NOT_GROUP", "success": false}' ]]; then
  echo "Direct-channel denial drifted: $direct_denial" >&2
  exit 1
fi

# A direct service writer wins the actor-role row lock and demotes the admin.
# The RPC must wait, re-read the locked role, deny, and leave the target intact.
psql_cmd \
  -c "BEGIN; UPDATE public.channel_members SET role='member' WHERE channel_id='10000000-0000-4000-8000-000000000001' AND user_id='22222222-2222-4222-8222-222222222222'; SELECT pg_catalog.pg_sleep(2); COMMIT" \
  >"$TMP_ROOT/demotion.out" 2>&1 &
demotion_pid=$!
sleep 0.3
race_result="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.mutate_channel_member_atomic('10000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','remove',NULL)")"
wait "$demotion_pid"
if [[ "$race_result" != '{"reason": "PERMISSION_DENIED", "success": false}' ]]; then
  echo "Concurrent actor demotion penetrated authority: $race_result" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000001' AND user_id='33333333-3333-4333-8333-333333333333'")" != "1" ]]; then
  echo "Denied concurrent removal changed the target" >&2
  exit 1
fi

leave_result="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.mutate_channel_member_atomic('10000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','22222222-2222-4222-8222-222222222222','leave',NULL)")"
if [[ "$leave_result" != *'"action": "leave"'* ]] \
  || [[ "$leave_result" != *'"role": null'* ]]; then
  echo "Exact leave acknowledgement was not returned: $leave_result" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.channel_members WHERE channel_id='10000000-0000-4000-8000-000000000001' AND user_id='22222222-2222-4222-8222-222222222222'")" != "0" ]]; then
  echo "Acknowledged leave did not delete exactly the actor membership" >&2
  exit 1
fi

echo "atomic-channel-member-mutation PG17 tests passed"
