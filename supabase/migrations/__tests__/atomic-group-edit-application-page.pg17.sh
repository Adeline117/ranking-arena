#!/usr/bin/env bash

# PostgreSQL 17 proof for atomic group edit-application page reads. It owns an
# isolated temporary cluster and never connects to an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729155000_atomic_group_edit_application_page.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-group-edit-application-page-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((55000 + ($$ % 2000)))
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
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  dissolved_at timestamptz
);
CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.group_edit_applications (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  applicant_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text,
  name_en text,
  description text,
  description_en text,
  avatar_url text,
  role_names jsonb,
  rules_json jsonb,
  rules text,
  is_premium_only boolean,
  status text NOT NULL DEFAULT 'pending',
  reject_reason text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.groups OWNER TO postgres;
ALTER TABLE public.group_members OWNER TO postgres;
ALTER TABLE public.group_edit_applications OWNER TO postgres;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_edit_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_profiles,
  public.groups,
  public.group_members,
  public.group_edit_applications
  FROM PUBLIC, anon, authenticated, service_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SELECT public.get_group_edit_applications_page_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001',NULL,NULL,50)"
expect_failure "SET ROLE rogue_role; SELECT public.get_group_edit_applications_page_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001',NULL,NULL,50)"
expect_failure "SET ROLE service_role; SELECT public.get_group_edit_applications_page_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001',NULL,NULL,50)"

psql_cmd <<'SQL'
DO $catalog_contract$
DECLARE
  v_function regprocedure :=
    'public.get_group_edit_applications_page_atomic(uuid,uuid,timestamptz,uuid,integer)'::regprocedure;
  v_postgres_oid oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres');
  v_service_oid oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role');
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::regtype
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_function, 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
    WHERE function_row.oid = v_function
      AND acl_entry.grantee <> function_row.proowner
      AND NOT (
        acl_entry.grantee = v_service_oid
        AND acl_entry.privilege_type = 'EXECUTE'
        AND NOT acl_entry.is_grantable
      )
  ) THEN
    RAISE EXCEPTION 'atomic edit-application function catalog contract failed';
  END IF;
END
$catalog_contract$;

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444'),
  ('55555555-5555-4555-8555-555555555555'),
  ('66666666-6666-4666-8666-666666666666');
INSERT INTO public.user_profiles(id, is_banned, ban_expires_at) VALUES
  ('11111111-1111-4111-8111-111111111111', false, NULL),
  ('22222222-2222-4222-8222-222222222222', false, NULL),
  ('33333333-3333-4333-8333-333333333333', false, NULL),
  ('44444444-4444-4444-8444-444444444444', false, NULL),
  ('55555555-5555-4555-8555-555555555555', true, 'infinity'),
  ('66666666-6666-4666-8666-666666666666', true, '2020-01-01T00:00:00Z');
INSERT INTO public.groups(id, created_by, dissolved_at) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    NULL
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '22222222-2222-4222-8222-222222222222',
    NULL
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    '11111111-1111-4111-8111-111111111111',
    '2026-07-29T00:00:00Z'
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    '66666666-6666-4666-8666-666666666666',
    NULL
  );
INSERT INTO public.group_members(group_id, user_id, role) VALUES
  ('10000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('10000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'admin'),
  ('10000000-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'member'),
  ('10000000-0000-4000-8000-000000000001', '55555555-5555-4555-8555-555555555555', 'owner'),
  ('10000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'admin'),
  ('10000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('10000000-0000-4000-8000-000000000004', '66666666-6666-4666-8666-666666666666', 'owner');
INSERT INTO public.group_edit_applications(
  id, group_id, applicant_id, name, name_en, description, avatar_url,
  role_names, rules_json, rules, is_premium_only, status, reject_reason,
  reviewed_at, created_at
) VALUES
  (
    '30000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'Newest proposal', NULL, 'private description', NULL,
    '{"admin":{"zh":"管理","en":"Admin"},"member":{"zh":"成员","en":"Member"}}',
    '[{"zh":"友善","en":"Kind"}]', 'private rules', false,
    'pending', NULL, NULL, '2026-07-29T20:00:00Z'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'Middle proposal', NULL, NULL, NULL, NULL, NULL, NULL, false,
    'rejected', 'private rejection', '2026-07-29T19:30:00Z',
    '2026-07-29T19:00:00Z'
  ),
  (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'Oldest proposal', NULL, NULL, NULL, NULL, NULL, NULL, false,
    'approved', NULL, '2026-07-29T18:30:00Z', '2026-07-29T18:00:00Z'
  ),
  (
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '22222222-2222-4222-8222-222222222222',
    'Legacy creator proposal', NULL, NULL, NULL, NULL, NULL, NULL, false,
    'pending', NULL, NULL, '2026-07-29T21:00:00Z'
  );
SQL

psql_cmd <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

DO $behavior_contract$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.get_group_edit_applications_page_atomic(
    '11111111-1111-4111-8111-111111111111',
    '10000000-0000-4000-8000-000000000001',
    NULL,
    NULL,
    2
  );
  IF v_result->>'success' <> 'true'
     OR v_result->>'actor_id' <> '11111111-1111-4111-8111-111111111111'
     OR v_result->>'group_id' <> '10000000-0000-4000-8000-000000000001'
     OR v_result->>'has_more' <> 'true'
     OR pg_catalog.jsonb_array_length(v_result->'applications') <> 2
     OR v_result->'applications'->0->>'id' <> '30000000-0000-4000-8000-000000000003'
     OR v_result->'applications'->1->>'id' <> '30000000-0000-4000-8000-000000000002'
     OR v_result->'applications'->0 ? 'reviewed_by'
  THEN
    RAISE EXCEPTION 'owner edit-application page contract failed: %', v_result;
  END IF;

  v_result := public.get_group_edit_applications_page_atomic(
    '11111111-1111-4111-8111-111111111111',
    '10000000-0000-4000-8000-000000000001',
    '2026-07-29T19:00:00Z',
    '30000000-0000-4000-8000-000000000002',
    2
  );
  IF v_result->>'success' <> 'true'
     OR v_result->>'has_more' <> 'false'
     OR pg_catalog.jsonb_array_length(v_result->'applications') <> 1
     OR v_result->'applications'->0->>'id' <> '30000000-0000-4000-8000-000000000001'
  THEN
    RAISE EXCEPTION 'edit-application cursor contract failed: %', v_result;
  END IF;

  v_result := public.get_group_edit_applications_page_atomic(
    '22222222-2222-4222-8222-222222222222',
    '10000000-0000-4000-8000-000000000002',
    NULL,
    NULL,
    100
  );
  IF v_result->>'success' <> 'true'
     OR pg_catalog.jsonb_array_length(v_result->'applications') <> 1
  THEN
    RAISE EXCEPTION 'legacy creator-admin compatibility failed: %', v_result;
  END IF;

  v_result := public.get_group_edit_applications_page_atomic(
    '66666666-6666-4666-8666-666666666666',
    '10000000-0000-4000-8000-000000000004',
    NULL,
    NULL,
    1
  );
  IF v_result->>'success' <> 'true' THEN
    RAISE EXCEPTION 'expired temporary ban semantics drifted: %', v_result;
  END IF;

  IF public.get_group_edit_applications_page_atomic(
       '22222222-2222-4222-8222-222222222222',
       '10000000-0000-4000-8000-000000000001', NULL, NULL, 1
     )->>'reason' <> 'PERMISSION_DENIED'
     OR public.get_group_edit_applications_page_atomic(
       '33333333-3333-4333-8333-333333333333',
       '10000000-0000-4000-8000-000000000001', NULL, NULL, 1
     )->>'reason' <> 'PERMISSION_DENIED'
     OR public.get_group_edit_applications_page_atomic(
       '44444444-4444-4444-8444-444444444444',
       '10000000-0000-4000-8000-000000000001', NULL, NULL, 1
     )->>'reason' <> 'PERMISSION_DENIED'
     OR public.get_group_edit_applications_page_atomic(
       '55555555-5555-4555-8555-555555555555',
       '10000000-0000-4000-8000-000000000001', NULL, NULL, 1
     )->>'reason' <> 'ACTOR_UNAVAILABLE'
     OR public.get_group_edit_applications_page_atomic(
       '11111111-1111-4111-8111-111111111111',
       '10000000-0000-4000-8000-000000000003', NULL, NULL, 1
     )->>'reason' <> 'GROUP_DISSOLVED'
     OR public.get_group_edit_applications_page_atomic(
       '11111111-1111-4111-8111-111111111111',
       '10000000-0000-4000-8000-000000000099', NULL, NULL, 1
     )->>'reason' <> 'GROUP_NOT_FOUND'
     OR public.get_group_edit_applications_page_atomic(
       '11111111-1111-4111-8111-111111111111',
       '10000000-0000-4000-8000-000000000001',
       '2026-07-29T19:00:00Z', NULL, 1
     )->>'reason' <> 'INVALID'
  THEN
    RAISE EXCEPTION 'edit-application denial contract failed';
  END IF;
END
$behavior_contract$;
SQL

# Hold an uncommitted owner demotion. The page must wait on that membership row
# and deny after commit instead of reading the stale owner snapshot.
PGAPPNAME=atomic-edit-application-demotion-race psql_cmd <<'SQL' >"$TMP_ROOT/demotion.out" 2>&1 &
BEGIN;
UPDATE public.group_members
SET role = 'member'
WHERE group_id = '10000000-0000-4000-8000-000000000001'
  AND user_id = '11111111-1111-4111-8111-111111111111';
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
demotion_pid=$!

race_ready=false
for _ in {1..80}; do
  if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = 'atomic-edit-application-demotion-race' AND state = 'active' AND wait_event = 'PgSleep'")" == "1" ]]; then
    race_ready=true
    break
  fi
  sleep 0.025
done
if [[ "$race_ready" != true ]]; then
  echo 'Concurrent owner demotion did not reach its proof barrier' >&2
  wait "$demotion_pid" || true
  exit 1
fi

race_result="$(psql_cmd -Atqc "SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); SELECT public.get_group_edit_applications_page_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001',NULL,NULL,50)->>'reason'")"
wait "$demotion_pid"
if [[ "${race_result##*$'\n'}" != 'PERMISSION_DENIED' ]]; then
  echo "Concurrent owner demotion leaked edit applications: $race_result" >&2
  exit 1
fi

echo 'atomic group edit-application page PG17 proof passed'
