#!/usr/bin/env bash

# PostgreSQL 17 proof for atomic group member-role changes. It owns an isolated
# temporary cluster and never connects to an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729142149_atomic_group_member_role_change.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-group-role-pg17.XXXXXX)"
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
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean,
  ban_expires_at timestamptz
);
CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  dissolved_at timestamptz
);
CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL DEFAULT 'member',
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.group_audit_log (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  group_id uuid REFERENCES public.groups(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_id uuid,
  details jsonb,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.groups OWNER TO postgres;
ALTER TABLE public.group_members OWNER TO postgres;
ALTER TABLE public.group_audit_log OWNER TO postgres;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.group_members
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.group_members TO service_role;
CREATE POLICY server_member ON public.group_members
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE FUNCTION public.serialize_group_membership_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_group_id uuid;
  v_user_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_group_id := OLD.group_id;
    v_user_id := OLD.user_id;
  ELSE
    v_group_id := NEW.group_id;
    v_user_id := NEW.user_id;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || v_group_id::text || ':' || v_user_id::text,
      0
    )
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.serialize_group_membership_edge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.serialize_group_membership_edge()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_group_members_05_serialize_edge
BEFORE INSERT OR UPDATE OF group_id, user_id OR DELETE
ON public.group_members
FOR EACH ROW EXECUTE FUNCTION public.serialize_group_membership_edge();

CREATE FUNCTION public.moderate_group_member_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_target_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || p_group_id::text || ':' || p_actor_id::text,
      0
    )
  );
  PERFORM 1 FROM public.user_profiles AS profile WHERE profile.id = p_actor_id;
  PERFORM 1 FROM public.groups AS target_group WHERE target_group.id = p_group_id;
  PERFORM 1
  FROM public.group_members AS member
  WHERE member.group_id = p_group_id
    AND member.user_id = p_target_id;
  RETURN pg_catalog.jsonb_build_object(
    'status', p_action || COALESCE(p_reason, '') || p_target_id::text
  );
END
$function$;
ALTER FUNCTION public.moderate_group_member_atomic(uuid, uuid, uuid, text, text)
  OWNER TO postgres;
REVOKE ALL
  ON FUNCTION public.moderate_group_member_atomic(uuid, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE
  ON FUNCTION public.moderate_group_member_atomic(uuid, uuid, uuid, text, text)
  TO service_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SELECT public.set_group_member_role_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','admin')"
expect_failure "SET ROLE rogue_role; SELECT public.set_group_member_role_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','admin')"

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
INSERT INTO public.groups(id, created_by, dissolved_at) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111', NULL
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    pg_catalog.clock_timestamp()
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    '11111111-1111-4111-8111-111111111111', NULL
  );
INSERT INTO public.group_members(group_id, user_id, role) VALUES
  ('10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111', 'owner'),
  ('10000000-0000-4000-8000-000000000001',
    '22222222-2222-4222-8222-222222222222', 'member'),
  ('10000000-0000-4000-8000-000000000001',
    '33333333-3333-4333-8333-333333333333', 'admin'),
  ('10000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111', 'owner'),
  ('10000000-0000-4000-8000-000000000002',
    '22222222-2222-4222-8222-222222222222', 'member'),
  ('10000000-0000-4000-8000-000000000003',
    '11111111-1111-4111-8111-111111111111', 'owner'),
  ('10000000-0000-4000-8000-000000000003',
    '22222222-2222-4222-8222-222222222222', 'owner');
SQL

promoted="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.set_group_member_role_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','admin')")"
if [[ "$promoted" != *'"success": true'* ]] \
  || [[ "$promoted" != *'"changed": true'* ]] \
  || [[ "$promoted" != *'"actor_id": "11111111-1111-4111-8111-111111111111"'* ]] \
  || [[ "$promoted" != *'"group_id": "10000000-0000-4000-8000-000000000001"'* ]] \
  || [[ "$promoted" != *'"target_id": "22222222-2222-4222-8222-222222222222"'* ]] \
  || [[ "$promoted" != *'"previous_role": "member"'* ]] \
  || [[ "$promoted" != *'"role": "admin"'* ]] \
  || [[ "$promoted" != *'"audit_id":'* ]]; then
  echo "Exact promotion acknowledgement was not returned: $promoted" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT action || ':' || (details->>'old_role') || ':' || (details->>'new_role') FROM public.group_audit_log")" != "promote:member:admin" ]]; then
  echo "Promotion audit evidence drifted" >&2
  exit 1
fi

idempotent="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.set_group_member_role_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','admin')")"
if [[ "$idempotent" != *'"success": true'* ]] \
  || [[ "$idempotent" != *'"changed": false'* ]] \
  || [[ "$idempotent" != *'"audit_id": null'* ]]; then
  echo "Idempotent role acknowledgement drifted: $idempotent" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_audit_log")" != "1" ]]; then
  echo "Idempotent role change invented an audit row" >&2
  exit 1
fi

demoted="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.set_group_member_role_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','member')")"
if [[ "$demoted" != *'"changed": true'* ]] \
  || [[ "$demoted" != *'"previous_role": "admin"'* ]] \
  || [[ "$demoted" != *'"role": "member"'* ]]; then
  echo "Exact demotion acknowledgement drifted: $demoted" >&2
  exit 1
fi

admin_denial="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.set_group_member_role_atomic('33333333-3333-4333-8333-333333333333','10000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','admin')")"
if [[ "$admin_denial" != '{"reason": "PERMISSION_DENIED", "success": false}' ]]; then
  echo "Non-owner role change was not denied: $admin_denial" >&2
  exit 1
fi

missing_target="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.set_group_member_role_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','44444444-4444-4444-8444-444444444444','admin')")"
if [[ "$missing_target" != '{"reason": "TARGET_NOT_MEMBER", "success": false}' ]]; then
  echo "Missing target membership was not denied: $missing_target" >&2
  exit 1
fi

dissolved="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.set_group_member_role_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','admin')")"
if [[ "$dissolved" != '{"reason": "GROUP_DISSOLVED", "success": false}' ]]; then
  echo "Dissolved group role change was not denied: $dissolved" >&2
  exit 1
fi

owner_denial="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.set_group_member_role_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000003','22222222-2222-4222-8222-222222222222','member')")"
if [[ "$owner_denial" != '{"reason": "OWNER_FORBIDDEN", "success": false}' ]]; then
  echo "Owner role mutation was not denied: $owner_denial" >&2
  exit 1
fi

# A legacy direct writer demotes the actor and holds the membership row. The
# RPC must wait, re-read the actor role, deny, and preserve the target role.
before_race_audits="$(psql_cmd -Atqc "SELECT count(*) FROM public.group_audit_log")"
psql_cmd \
  -c "BEGIN; UPDATE public.group_members SET role='member' WHERE group_id='10000000-0000-4000-8000-000000000001' AND user_id='11111111-1111-4111-8111-111111111111'; SELECT pg_catalog.pg_sleep(2); COMMIT" \
  >"$TMP_ROOT/demotion.out" 2>&1 &
demotion_pid=$!
sleep 0.3
race_result="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.set_group_member_role_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','admin')")"
wait "$demotion_pid"
if [[ "$race_result" != '{"reason": "PERMISSION_DENIED", "success": false}' ]]; then
  echo "Concurrent owner demotion penetrated role authority: $race_result" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT role FROM public.group_members WHERE group_id='10000000-0000-4000-8000-000000000001' AND user_id='22222222-2222-4222-8222-222222222222'")" != "member" ]]; then
  echo "Denied owner-demotion race changed the target role" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_audit_log")" != "$before_race_audits" ]]; then
  echo "Denied owner-demotion race invented audit evidence" >&2
  exit 1
fi

echo "atomic-group-member-role-change PG17 tests passed"
