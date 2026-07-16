#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for transactional group ban/kick/unban.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MEMBERSHIP_MIGRATION="$ROOT_DIR/supabase/migrations/20260716113900_atomic_group_membership.sql"
MODERATION_MIGRATION="$ROOT_DIR/supabase/migrations/20260716114100_atomic_group_member_moderation.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
for migration in "$MEMBERSHIP_MIGRATION" "$MODERATION_MIGRATION"; do
  if [[ ! -f "$migration" ]]; then
    echo "Required group migration is missing: $migration" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/atomic-group-moderation-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55481
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if (( exit_status != 0 )) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    echo "PostgreSQL 17 integration cluster log:" >&2
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" \
    -X \
    -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" \
    -p "$PORT" \
    -d postgres \
    "$@"
}

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE drifted_moderator NOLOGIN;

CREATE SCHEMA auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;
ALTER FUNCTION auth.uid() OWNER TO postgres;

GRANT USAGE ON SCHEMA public, auth
  TO anon, authenticated, service_role, drifted_moderator;
GRANT EXECUTE ON FUNCTION auth.uid()
  TO anon, authenticated, service_role, drifted_moderator;

CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE public.group_visibility AS ENUM ('open', 'apply');

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean DEFAULT false,
  ban_expires_at timestamptz,
  subscription_tier text DEFAULT 'free',
  reputation_score integer DEFAULT 0,
  is_verified_trader boolean DEFAULT false
);
CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  created_by uuid NOT NULL,
  visibility public.group_visibility NOT NULL DEFAULT 'open',
  member_count integer,
  dissolved_at timestamptz,
  is_premium_only boolean DEFAULT false,
  min_arena_score integer DEFAULT 0,
  is_verified_only boolean DEFAULT false
);
CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role public.member_role NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.group_bans (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  banned_by uuid,
  reason text,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.group_invites (
  id uuid PRIMARY KEY,
  group_id uuid REFERENCES public.groups(id) ON DELETE CASCADE,
  created_by uuid,
  token_hash text NOT NULL,
  max_uses integer,
  used_count integer,
  expires_at timestamptz,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.group_join_requests (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  answer_text text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.group_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id uuid,
  actor_id uuid,
  action text NOT NULL,
  target_id uuid,
  details jsonb,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.groups OWNER TO postgres;
ALTER TABLE public.group_members OWNER TO postgres;
ALTER TABLE public.group_bans OWNER TO postgres;
ALTER TABLE public.group_invites OWNER TO postgres;
ALTER TABLE public.group_join_requests OWNER TO postgres;
ALTER TABLE public.group_audit_log OWNER TO postgres;

GRANT SELECT ON public.groups, public.group_members TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.groups, public.group_members
  TO service_role;
GRANT ALL PRIVILEGES ON public.group_bans
  TO PUBLIC, anon, authenticated, service_role, drifted_moderator;
GRANT SELECT (group_id), INSERT (user_id), UPDATE (reason), REFERENCES (group_id)
  ON public.group_bans
  TO PUBLIC, anon, authenticated, service_role, drifted_moderator;

INSERT INTO public.user_profiles(id, subscription_tier, reputation_score, is_verified_trader)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'pro', 100, true),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'pro', 80, true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'free', 50, true),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'free', 50, true),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'free', 50, true),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'free', 50, true),
  ('11111111-1111-4111-8111-111111111111', 'free', 50, true),
  ('22222222-2222-4222-8222-222222222222', 'free', 50, true);

INSERT INTO public.groups(id, created_by, member_count)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  99
);
INSERT INTO public.group_members(group_id, user_id, role)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('10000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'admin'),
  ('10000000-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'member'),
  ('10000000-0000-4000-8000-000000000001', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'member'),
  ('10000000-0000-4000-8000-000000000001', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'member'),
  ('10000000-0000-4000-8000-000000000001', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'member');
SQL

psql_cmd -f "$MEMBERSHIP_MIGRATION" >"$LOG_DIR/membership.log"

# Existing overlap is ambiguous evidence; moderation migration must not repair it.
psql_cmd -c \
  "INSERT INTO public.group_bans(group_id, user_id, banned_by) VALUES ('10000000-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')" \
  >/dev/null
if psql_cmd -f "$MODERATION_MIGRATION" >"$LOG_DIR/overlap.log" 2>&1; then
  echo "Moderation migration unexpectedly cleaned or accepted overlap" >&2
  exit 1
fi
grep -Fq 'existing banned memberships require explicit review' "$LOG_DIR/overlap.log"
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_bans WHERE user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'")" != "1" ]] || \
  [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_members WHERE user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'")" != "1" ]]; then
  echo "Overlap evidence changed after failed moderation migration" >&2
  exit 1
fi
psql_cmd -c \
  "DELETE FROM public.group_bans WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'" \
  >/dev/null

psql_cmd -f "$MODERATION_MIGRATION" >"$LOG_DIR/first-apply.log"

GROUP_ID="'10000000-0000-4000-8000-000000000001'::uuid"
OWNER_ID="'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid"
ADMIN_ID="'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid"

assert_status() {
  local expected="$1"
  local expression="$2"
  local actual
  actual="$(psql_cmd -Atqc "SET ROLE service_role; SELECT ($expression)->>'status'; RESET ROLE;")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected moderation status '$expected', got '$actual'" >&2
    exit 1
  fi
}

wait_for_sleep_gate() {
  local application_name="$1"
  for _ in {1..100}; do
    if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = '$application_name' AND state = 'active' AND query LIKE '%pg_sleep%'")" == "1" ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "Concurrency gate did not become ready: $application_name" >&2
  return 1
}

# Direct service-role mutation is gone; reads remain available.
if psql_cmd -c \
  "SET ROLE service_role; INSERT INTO public.group_bans(group_id, user_id) VALUES ('10000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222')" \
  >"$LOG_DIR/direct-ban.log" 2>&1; then
  echo "Service role unexpectedly retained direct group_bans mutation" >&2
  exit 1
fi
grep -Fq 'permission denied for table group_bans' "$LOG_DIR/direct-ban.log"

# Even the owner cannot create overlapping edges outside the atomic ordering.
if psql_cmd -c \
  "INSERT INTO public.group_bans(group_id, user_id) VALUES ('10000000-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')" \
  >"$LOG_DIR/direct-overlap.log" 2>&1; then
  echo "Ban exclusion trigger unexpectedly accepted a current member" >&2
  exit 1
fi
grep -Fq 'group member must be removed before ban insertion' "$LOG_DIR/direct-overlap.log"

# Kick, rejoin, ban and unban all mutate audit/count state atomically.
assert_status kicked \
  "public.moderate_group_member_atomic($ADMIN_ID, $GROUP_ID, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'kick', 'cleanup')"
assert_status not_member \
  "public.moderate_group_member_atomic($ADMIN_ID, $GROUP_ID, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'kick', NULL)"
assert_status joined \
  "public.mutate_group_membership_atomic('cccccccc-cccc-4ccc-8ccc-cccccccccccc', $GROUP_ID, 'join', false)"
assert_status banned \
  "public.moderate_group_member_atomic($ADMIN_ID, $GROUP_ID, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'ban', 'abuse')"
assert_status banned \
  "public.mutate_group_membership_atomic('cccccccc-cccc-4ccc-8ccc-cccccccccccc', $GROUP_ID, 'join', false)"
assert_status already_banned \
  "public.moderate_group_member_atomic($ADMIN_ID, $GROUP_ID, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'ban', NULL)"
assert_status unbanned \
  "public.moderate_group_member_atomic($ADMIN_ID, $GROUP_ID, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'unban', NULL)"
assert_status already_unbanned \
  "public.moderate_group_member_atomic($ADMIN_ID, $GROUP_ID, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'unban', NULL)"

assert_status owner_forbidden \
  "public.moderate_group_member_atomic($ADMIN_ID, $GROUP_ID, $OWNER_ID, 'kick', NULL)"
assert_status owner_forbidden \
  "public.moderate_group_member_atomic($ADMIN_ID, $GROUP_ID, $OWNER_ID, 'ban', NULL)"
assert_status self_forbidden \
  "public.moderate_group_member_atomic($ADMIN_ID, $GROUP_ID, $ADMIN_ID, 'kick', NULL)"
assert_status forbidden \
  "public.moderate_group_member_atomic('dddddddd-dddd-4ddd-8ddd-dddddddddddd', $GROUP_ID, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'kick', NULL)"

# An audit failure after delete/ban insertion rolls the entire transaction back.
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.fail_selected_group_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.target_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    AND NEW.action = 'ban'
  THEN
    RAISE EXCEPTION 'injected moderation audit failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_fail_selected_group_audit
  BEFORE INSERT ON public.group_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.fail_selected_group_audit();
SQL
if psql_cmd -c \
  "SET ROLE service_role; SELECT public.moderate_group_member_atomic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'ban', 'rollback')" \
  >"$LOG_DIR/audit-failure.log" 2>&1; then
  echo "Injected moderation audit failure unexpectedly committed" >&2
  exit 1
fi
grep -Fq 'injected moderation audit failure' "$LOG_DIR/audit-failure.log"
psql_cmd <<'SQL'
DO $rollback_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = '10000000-0000-4000-8000-000000000001'
      AND user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  ) OR EXISTS (
    SELECT 1 FROM public.group_bans
    WHERE group_id = '10000000-0000-4000-8000-000000000001'
      AND user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  ) THEN
    RAISE EXCEPTION 'failed moderation left partial member/ban state';
  END IF;
END
$rollback_proof$;
DROP TRIGGER trg_fail_selected_group_audit ON public.group_audit_log;
DROP FUNCTION public.fail_selected_group_audit();
SQL

# Ban wins: join waits on the shared edge and then observes committed ban.
PGAPPNAME=moderation_ban_first psql_cmd >"$LOG_DIR/ban-first.out" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SELECT public.moderate_group_member_atomic(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000001',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'ban',
  'ban first'
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
BAN_FIRST_PID=$!

wait_for_sleep_gate moderation_ban_first
assert_status banned \
  "public.mutate_group_membership_atomic('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', $GROUP_ID, 'join', false)"
wait "$BAN_FIRST_PID"
assert_status unbanned \
  "public.moderate_group_member_atomic($OWNER_ID, $GROUP_ID, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'unban', NULL)"

# Join wins: ban waits, then removes the committed member and installs the ban.
PGAPPNAME=moderation_join_first psql_cmd >"$LOG_DIR/join-first.out" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SELECT public.mutate_group_membership_atomic(
  '11111111-1111-4111-8111-111111111111',
  '10000000-0000-4000-8000-000000000001',
  'join',
  false
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
JOIN_FIRST_PID=$!

wait_for_sleep_gate moderation_join_first
assert_status banned \
  "public.moderate_group_member_atomic($OWNER_ID, $GROUP_ID, '11111111-1111-4111-8111-111111111111', 'ban', 'join first')"
wait "$JOIN_FIRST_PID"

# Actor demotion and target promotion are re-read after row-lock waits.
PGAPPNAME=moderation_actor_demote psql_cmd >"$LOG_DIR/actor-demote.out" 2>&1 <<'SQL' &
BEGIN;
UPDATE public.group_members
SET role = 'member'
WHERE group_id = '10000000-0000-4000-8000-000000000001'
  AND user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
DEMOTE_PID=$!
wait_for_sleep_gate moderation_actor_demote
assert_status forbidden \
  "public.moderate_group_member_atomic($ADMIN_ID, $GROUP_ID, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'kick', NULL)"
wait "$DEMOTE_PID"
psql_cmd -c \
  "UPDATE public.group_members SET role = 'admin' WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'" \
  >/dev/null

PGAPPNAME=moderation_target_promote psql_cmd >"$LOG_DIR/target-promote.out" 2>&1 <<'SQL' &
BEGIN;
UPDATE public.group_members
SET role = 'admin'
WHERE group_id = '10000000-0000-4000-8000-000000000001'
  AND user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
PROMOTE_PID=$!
wait_for_sleep_gate moderation_target_promote
assert_status hierarchy_forbidden \
  "public.moderate_group_member_atomic($ADMIN_ID, $GROUP_ID, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'kick', NULL)"
wait "$PROMOTE_PID"
psql_cmd -c \
  "UPDATE public.group_members SET role = 'member' WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'" \
  >/dev/null

# Authenticated reads are scoped to group administrators by RLS.
admin_visible="$(psql_cmd -Atqc "SET request.jwt.claim.sub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; SET ROLE authenticated; SELECT count(*) FROM public.group_bans; RESET ROLE;")"
member_visible="$(psql_cmd -Atqc "SET request.jwt.claim.sub = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; SET ROLE authenticated; SELECT count(*) FROM public.group_bans; RESET ROLE;")"
if [[ "$admin_visible" != "1" ]] || [[ "$member_visible" != "0" ]]; then
  echo "Authenticated group_bans read policy was not bounded to administrators" >&2
  exit 1
fi

# Replay converges arbitrary ACL/policy/function drift.
psql_cmd <<'SQL'
GRANT ALL PRIVILEGES ON public.group_bans
  TO PUBLIC, anon, authenticated, service_role, drifted_moderator;
GRANT SELECT (group_id), INSERT (user_id), UPDATE (reason), REFERENCES (group_id)
  ON public.group_bans
  TO PUBLIC, anon, authenticated, service_role, drifted_moderator;
CREATE POLICY unexpected_ban_writer
  ON public.group_bans
  FOR ALL
  TO drifted_moderator
  USING (true)
  WITH CHECK (true);
GRANT EXECUTE ON FUNCTION public.moderate_group_member_atomic(
  uuid, uuid, uuid, text, text
) TO drifted_moderator;
GRANT EXECUTE ON FUNCTION public.reject_banned_group_membership()
  TO PUBLIC, drifted_moderator;
GRANT EXECUTE ON FUNCTION public.reject_member_group_ban()
  TO PUBLIC, drifted_moderator;
SQL
psql_cmd -f "$MODERATION_MIGRATION" >"$LOG_DIR/replay.log"

psql_cmd <<'SQL'
DO $catalog_and_data_contract$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.group_members AS member
    JOIN public.group_bans AS ban
      ON ban.group_id = member.group_id
     AND ban.user_id = member.user_id
  ) OR EXISTS (
    SELECT 1
    FROM public.groups AS target_group
    WHERE target_group.member_count <> (
      SELECT pg_catalog.count(*)::integer
      FROM public.group_members AS member
      WHERE member.group_id = target_group.id
    )
  ) THEN
    RAISE EXCEPTION 'moderation invariant or count drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.moderate_group_member_atomic(uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.moderate_group_member_atomic(uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'drifted_moderator',
    'public.moderate_group_member_atomic(uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'drifted_moderator',
    'public.reject_banned_group_membership()',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.reject_member_group_ban()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'moderation function ACL drifted';
  END IF;

  IF pg_catalog.has_table_privilege(
    'service_role', 'public.group_bans',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_table_privilege(
    'drifted_moderator', 'public.group_bans',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_any_column_privilege(
    'drifted_moderator', 'public.group_bans',
    'SELECT,INSERT,UPDATE,REFERENCES'
  ) OR (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.group_bans'::regclass
  ) <> 3 THEN
    RAISE EXCEPTION 'group_bans ACL/policy drift survived replay';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.group_bans
    WHERE group_id = '10000000-0000-4000-8000-000000000001'
      AND user_id = '11111111-1111-4111-8111-111111111111'
  ) OR EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = '10000000-0000-4000-8000-000000000001'
      AND user_id = '11111111-1111-4111-8111-111111111111'
  ) THEN
    RAISE EXCEPTION 'join-first moderation result was not canonical';
  END IF;
END
$catalog_and_data_contract$;
SQL

echo "atomic group member moderation PG17 integration proof passed"
