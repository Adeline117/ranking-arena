#!/usr/bin/env bash

# PostgreSQL 17 proof for the deleted-account group edge purge boundary.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716114900_atomic_deleted_account_group_purge.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ ! -f "$MIGRATION" ]]; then
  echo "Deleted-account group purge migration is missing: $MIGRATION" >&2
  exit 1
fi
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/atomic-deleted-account-group-purge-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55519
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)) && [[ -f "$LOG_DIR/postgres.log" ]]; then
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
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE TABLE auth.users (id uuid PRIMARY KEY);
ALTER TABLE auth.users OWNER TO postgres;
CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member');
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  deletion_scheduled_at timestamptz
);
CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  member_count integer NOT NULL DEFAULT 0
);
CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role public.member_role NOT NULL DEFAULT 'member',
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.group_bans (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.edge_trigger_log (
  relation_name text NOT NULL,
  operation text NOT NULL,
  group_id uuid NOT NULL,
  user_id uuid NOT NULL
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.groups OWNER TO postgres;
ALTER TABLE public.group_members OWNER TO postgres;
ALTER TABLE public.group_bans OWNER TO postgres;
ALTER TABLE public.edge_trigger_log OWNER TO postgres;

CREATE FUNCTION public.serialize_group_membership_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_group_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.group_id ELSE NEW.group_id END;
  v_user_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || v_group_id::text || ':' || v_user_id::text,
      0
    )
  );
  INSERT INTO public.edge_trigger_log(relation_name, operation, group_id, user_id)
  VALUES (TG_TABLE_NAME, TG_OP, v_group_id, v_user_id);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.serialize_group_membership_edge() OWNER TO postgres;

CREATE FUNCTION public.sync_group_member_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.groups
    SET member_count = COALESCE(member_count, 0) + 1
    WHERE id = NEW.group_id;
    RETURN NEW;
  END IF;
  UPDATE public.groups
  SET member_count = GREATEST(COALESCE(member_count, 0) - 1, 0)
  WHERE id = OLD.group_id;
  RETURN OLD;
END
$function$;
ALTER FUNCTION public.sync_group_member_count() OWNER TO postgres;

CREATE FUNCTION public.reject_group_membership_identity_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
  THEN
    RAISE EXCEPTION 'group membership identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.reject_group_membership_identity_update() OWNER TO postgres;

CREATE FUNCTION public.mutate_group_membership_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_action text,
  p_pro_free_promo boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_deleted_at timestamptz;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || p_group_id::text || ':' || p_actor_id::text,
      0
    )
  );
  SELECT profile.deleted_at INTO v_deleted_at
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR UPDATE;
  IF NOT FOUND OR v_deleted_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;
  IF p_action = 'join' THEN
    INSERT INTO public.group_members(group_id, user_id, role)
    VALUES (p_group_id, p_actor_id, 'member')
    ON CONFLICT (group_id, user_id) DO NOTHING;
    RETURN pg_catalog.jsonb_build_object('status', 'joined');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'invalid');
END
$function$;
ALTER FUNCTION public.mutate_group_membership_atomic(uuid, uuid, text, boolean)
  OWNER TO postgres;

CREATE FUNCTION public.moderate_group_member_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_target_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT pg_catalog.jsonb_build_object('status', 'fixture')
$function$;
ALTER FUNCTION public.moderate_group_member_atomic(uuid, uuid, uuid, text, text)
  OWNER TO postgres;

CREATE TRIGGER trg_group_members_05_serialize_edge
  BEFORE INSERT OR UPDATE OF group_id, user_id OR DELETE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.serialize_group_membership_edge();
CREATE TRIGGER trg_group_bans_05_serialize_edge
  BEFORE INSERT OR UPDATE OF group_id, user_id OR DELETE ON public.group_bans
  FOR EACH ROW EXECUTE FUNCTION public.serialize_group_membership_edge();
CREATE TRIGGER trg_sync_group_member_count
  AFTER INSERT OR DELETE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.sync_group_member_count();
CREATE TRIGGER trg_group_members_99_identity_immutable
  AFTER UPDATE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.reject_group_membership_identity_update();

INSERT INTO auth.users(id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
INSERT INTO public.user_profiles(id, deleted_at, deletion_scheduled_at) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL, NULL),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', now() - interval '31 days', now() - interval '1 day'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', now(), now() + interval '30 days'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', now() - interval '31 days', NULL);
INSERT INTO public.groups(id) VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000002'),
  ('30000000-0000-4000-8000-000000000003'),
  ('40000000-0000-4000-8000-000000000004');
INSERT INTO public.group_members(group_id, user_id, role) VALUES
  ('10000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'owner'),
  ('20000000-0000-4000-8000-000000000002', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'member'),
  ('10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member');
INSERT INTO public.group_bans(group_id, user_id) VALUES
  ('30000000-0000-4000-8000-000000000003', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
INSERT INTO public.group_members(group_id, user_id, role) VALUES
  (
    '40000000-0000-4000-8000-000000000004',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'member'
  );
TRUNCATE public.edge_trigger_log;
SQL

# A committed orphan makes the missing-FK first install fail before any
# function, trigger, or constraint is installed.
if psql_cmd -f "$MIGRATION" >"$LOG_DIR/missing-fk-orphan.log" 2>&1; then
  echo "Missing group_members FK unexpectedly accepted an orphan" >&2
  exit 1
fi
grep -Fq 'group_members user_id FK is missing and orphan rows exist' \
  "$LOG_DIR/missing-fk-orphan.log"

psql_cmd <<'SQL'
DO $orphan_preflight_rollback_proof$
DECLARE
  user_id_attnum smallint := (
    SELECT attribute.attnum
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.group_members'::pg_catalog.regclass
      AND attribute.attname = 'user_id'
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members AS member
    WHERE member.user_id =
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid =
        'public.group_members'::pg_catalog.regclass
      AND constraint_info.contype = 'f'
      AND user_id_attnum = ANY (constraint_info.conkey)
  ) OR pg_catalog.to_regprocedure(
    'public.reject_inactive_group_edge()'
  ) IS NOT NULL OR pg_catalog.to_regprocedure(
    'public.purge_deleted_account_group_edges(uuid)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'orphan preflight failure partially mutated the migration';
  END IF;
END
$orphan_preflight_rollback_proof$;

DELETE FROM public.group_members
WHERE user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
TRUNCATE public.edge_trigger_log;
SQL

# One noncanonical user_id FK is not an "absent" contract and must never be
# silently dropped or replaced.
psql_cmd <<'SQL'
ALTER TABLE public.group_members
  ADD CONSTRAINT unexpected_group_members_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES auth.users(id)
  ON DELETE RESTRICT;
SQL
if psql_cmd -f "$MIGRATION" >"$LOG_DIR/unexpected-single-fk.log" 2>&1; then
  echo "Migration unexpectedly replaced a noncanonical group_members FK" >&2
  exit 1
fi
grep -Fq 'account purge CASCADE FK is incompatible: public.group_members' \
  "$LOG_DIR/unexpected-single-fk.log"
if [[ "$(psql_cmd -Atqc "SELECT to_regprocedure('public.reject_inactive_group_edge()') IS NULL AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.group_members'::regclass AND conname = 'unexpected_group_members_user_id_fkey') AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.group_members'::regclass AND conname = 'group_members_user_id_fkey')")" != "t" ]]; then
  echo "Noncanonical FK failure changed the original constraint state" >&2
  exit 1
fi
psql_cmd -c \
  'ALTER TABLE public.group_members DROP CONSTRAINT unexpected_group_members_user_id_fkey' \
  >/dev/null

# Commit an orphan after preflight has observed an empty FK-compatible state
# but before ACCESS EXCLUSIVE is acquired. The validated ADD CONSTRAINT must
# catch it under the lock and roll the entire migration back.
(
  PGAPPNAME=concurrent_group_member_orphan psql_cmd <<'SQL'
BEGIN;
INSERT INTO public.group_members(group_id, user_id, role) VALUES (
  '40000000-0000-4000-8000-000000000004',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'member'
);
SELECT /* concurrent_group_member_orphan */ pg_catalog.pg_sleep(1.2);
COMMIT;
SQL
) >"$LOG_DIR/concurrent-orphan-writer.log" 2>&1 &
ORPHAN_WRITER_PID=$!

for _ in {1..50}; do
  if [[ "$(psql_cmd -Atqc "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'concurrent_group_member_orphan' AND wait_event = 'PgSleep')")" == "t" ]]; then
    break
  fi
  sleep 0.05
done
if [[ "$(psql_cmd -Atqc "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'concurrent_group_member_orphan' AND wait_event = 'PgSleep')")" != "t" ]]; then
  echo "Failed to pause the concurrent orphan writer" >&2
  exit 1
fi

if psql_cmd -f "$MIGRATION" >"$LOG_DIR/concurrent-orphan-validation.log" 2>&1; then
  echo "Validated FK unexpectedly accepted a concurrently committed orphan" >&2
  exit 1
fi
wait "$ORPHAN_WRITER_PID"
grep -Fq 'violates foreign key constraint "group_members_user_id_fkey"' \
  "$LOG_DIR/concurrent-orphan-validation.log"

psql_cmd <<'SQL'
DO $concurrent_orphan_rollback_proof$
DECLARE
  user_id_attnum smallint := (
    SELECT attribute.attnum
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.group_members'::pg_catalog.regclass
      AND attribute.attname = 'user_id'
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members AS member
    WHERE member.user_id =
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid =
        'public.group_members'::pg_catalog.regclass
      AND constraint_info.contype = 'f'
      AND user_id_attnum = ANY (constraint_info.conkey)
  ) OR pg_catalog.to_regprocedure(
    'public.reject_inactive_group_edge()'
  ) IS NOT NULL THEN
    RAISE EXCEPTION
      'concurrent orphan validation did not roll back migration state';
  END IF;
END
$concurrent_orphan_rollback_proof$;

DELETE FROM public.group_members
WHERE user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
TRUNCATE public.edge_trigger_log;
SQL

psql_cmd -f "$MIGRATION" >"$LOG_DIR/first-apply.log"

psql_cmd <<'SQL'
DO $missing_fk_first_install_proof$
DECLARE
  user_id_attnum smallint := (
    SELECT attribute.attnum
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.group_members'::pg_catalog.regclass
      AND attribute.attname = 'user_id'
  );
  auth_id_attnum smallint := (
    SELECT attribute.attnum
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
      AND attribute.attname = 'id'
  );
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid =
        'public.group_members'::pg_catalog.regclass
      AND constraint_info.contype = 'f'
      AND user_id_attnum = ANY (constraint_info.conkey)
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid =
        'public.group_members'::pg_catalog.regclass
      AND constraint_info.conname = 'group_members_user_id_fkey'
      AND constraint_info.contype = 'f'
      AND constraint_info.conkey = ARRAY[user_id_attnum]::smallint[]
      AND constraint_info.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_info.confkey = ARRAY[auth_id_attnum]::smallint[]
      AND constraint_info.confmatchtype = 's'
      AND constraint_info.confupdtype = 'a'
      AND constraint_info.confdeltype = 'c'
      AND constraint_info.convalidated
      AND NOT constraint_info.condeferrable
      AND NOT constraint_info.condeferred
  ) THEN
    RAISE EXCEPTION 'missing FK first install did not create the exact contract';
  END IF;
END
$missing_fk_first_install_proof$;
SQL

psql_cmd -f "$MIGRATION" >"$LOG_DIR/missing-fk-immediate-replay.log"

# Only service_role may cross the RPC boundary.
if psql_cmd -c \
  "SET ROLE authenticated; SELECT public.purge_deleted_account_group_edges('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');" \
  >"$LOG_DIR/authenticated-rpc.log" 2>&1; then
  echo "Authenticated role unexpectedly executed account group purge" >&2
  exit 1
fi
grep -Fq 'permission denied for function purge_deleted_account_group_edges' \
  "$LOG_DIR/authenticated-rpc.log"

assert_status() {
  local user_id="$1"
  local expected="$2"
  local actual
  actual="$(psql_cmd -Atqc "SET ROLE service_role; SELECT (public.purge_deleted_account_group_edges('$user_id'))->>'status'; RESET ROLE;")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected purge status '$expected' for $user_id, got '$actual'" >&2
    exit 1
  fi
}

assert_status aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa account_active
assert_status cccccccc-cccc-4ccc-8ccc-cccccccccccc grace_period_active
assert_status dddddddd-dddd-4ddd-8ddd-dddddddddddd not_scheduled

PURGE_RESULT="$(psql_cmd -Atqc "SET ROLE service_role; SELECT public.purge_deleted_account_group_edges('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'); RESET ROLE;")"
if [[ "$(psql_cmd -Atqc "SELECT ('$PURGE_RESULT'::jsonb = jsonb_build_object('status', 'purged', 'memberships_removed', 2, 'bans_removed', 1, 'owner_memberships_removed', 1))")" != "t" ]]; then
  echo "Expired account purge returned an incomplete result: $PURGE_RESULT" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $purge_state_exact$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.group_members
    WHERE user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ) OR EXISTS (
    SELECT 1 FROM public.group_bans
    WHERE user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ) OR EXISTS (
    SELECT 1
    FROM public.groups AS target_group
    WHERE target_group.member_count IS DISTINCT FROM (
      SELECT pg_catalog.count(*)::integer
      FROM public.group_members AS member
      WHERE member.group_id = target_group.id
    )
  ) THEN
    RAISE EXCEPTION 'purge edge or member_count state is not exact';
  END IF;
END
$purge_state_exact$;
SQL

# Replay is idempotent, and a second purge removes zero edges.
psql_cmd -f "$MIGRATION" >"$LOG_DIR/clean-replay.log"
SECOND_RESULT="$(psql_cmd -Atqc "SET ROLE service_role; SELECT public.purge_deleted_account_group_edges('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'); RESET ROLE;")"
if [[ "$(psql_cmd -Atqc "SELECT ('$SECOND_RESULT'::jsonb = jsonb_build_object('status', 'purged', 'memberships_removed', 0, 'bans_removed', 0, 'owner_memberships_removed', 0))")" != "t" ]]; then
  echo "Idempotent purge returned an unexpected result: $SECOND_RESULT" >&2
  exit 1
fi

# Neither direct privileged writes nor the canonical join can rebuild an edge.
if psql_cmd -c \
  "INSERT INTO public.group_members(group_id, user_id, role) VALUES ('40000000-0000-4000-8000-000000000004', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'member');" \
  >"$LOG_DIR/inactive-member-insert.log" 2>&1; then
  echo "Inactive account unexpectedly rebuilt group membership" >&2
  exit 1
fi
grep -Fq 'inactive account cannot create a group membership edge' \
  "$LOG_DIR/inactive-member-insert.log"
if psql_cmd -c \
  "INSERT INTO public.group_bans(group_id, user_id) VALUES ('40000000-0000-4000-8000-000000000004', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');" \
  >"$LOG_DIR/inactive-ban-insert.log" 2>&1; then
  echo "Inactive account unexpectedly rebuilt group ban" >&2
  exit 1
fi
grep -Fq 'inactive account cannot create a group membership edge' \
  "$LOG_DIR/inactive-ban-insert.log"
JOIN_STATUS="$(psql_cmd -Atqc "SELECT (public.mutate_group_membership_atomic('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '40000000-0000-4000-8000-000000000004', 'join', false))->>'status'")"
if [[ "$JOIN_STATUS" != "account_inactive" ]]; then
  echo "Canonical join did not reject the inactive account" >&2
  exit 1
fi

# Hold the exact edge lock during Auth deletion. Because the purge removed all
# child group edges, the parent cascade must finish below one second and invoke
# no membership/ban serialization trigger.
psql_cmd -c 'TRUNCATE public.edge_trigger_log' >/dev/null
(
  psql_cmd -c \
    "BEGIN; SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('group-membership:10000000-0000-4000-8000-000000000001:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 0)); SELECT pg_catalog.pg_sleep(2); COMMIT;" \
    >"$LOG_DIR/held-edge-lock.log"
) &
LOCK_HOLDER_PID=$!

for _ in {1..50}; do
  if [[ "$(psql_cmd -Atqc "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND granted)")" == "t" ]]; then
    break
  fi
  sleep 0.05
done
if [[ "$(psql_cmd -Atqc "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND granted)")" != "t" ]]; then
  echo "Failed to establish concurrent membership edge lock" >&2
  exit 1
fi

psql_cmd <<'SQL'
SET statement_timeout = '1s';
DELETE FROM auth.users
WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
RESET statement_timeout;
SQL
wait "$LOCK_HOLDER_PID"

if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.edge_trigger_log")" != "0" ]] || \
  [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.user_profiles WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'")" != "0" ]]; then
  echo "Post-purge Auth cascade invoked an edge trigger or retained the profile" >&2
  exit 1
fi

# An additional same-column RESTRICT FK must make replay fail before mutation.
psql_cmd <<'SQL'
ALTER TABLE public.group_members
  ADD CONSTRAINT malicious_group_member_user_restrict
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
SQL
if psql_cmd -f "$MIGRATION" >"$LOG_DIR/extra-fk-replay.log" 2>&1; then
  echo "Migration replay unexpectedly accepted an extra user FK" >&2
  exit 1
fi
grep -Fq 'account purge CASCADE FK is incompatible: public.group_members' \
  "$LOG_DIR/extra-fk-replay.log"
psql_cmd -c \
  'ALTER TABLE public.group_members DROP CONSTRAINT malicious_group_member_user_restrict' \
  >/dev/null

# An overload aborts before repair. Removing it lets replay converge a leaked
# grant and a same-name WHEN(false) trigger back to the exact contract.
psql_cmd <<'SQL'
CREATE FUNCTION public.purge_deleted_account_group_edges(p_user_id text)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT '{}'::jsonb
$function$;
GRANT EXECUTE ON FUNCTION public.purge_deleted_account_group_edges(uuid)
  TO authenticated;
DROP TRIGGER trg_group_members_08_reject_inactive_account
  ON public.group_members;
CREATE TRIGGER trg_group_members_08_reject_inactive_account
  BEFORE INSERT OR UPDATE OF group_id, user_id ON public.group_members
  FOR EACH ROW
  WHEN (false)
  EXECUTE FUNCTION public.reject_inactive_group_edge();
SQL
if psql_cmd -f "$MIGRATION" >"$LOG_DIR/overload-replay.log" 2>&1; then
  echo "Migration replay unexpectedly accepted a purge overload" >&2
  exit 1
fi
grep -Fq 'unexpected deleted-account group purge overload exists' \
  "$LOG_DIR/overload-replay.log"
if [[ "$(psql_cmd -Atqc "SELECT has_function_privilege('authenticated', 'public.purge_deleted_account_group_edges(uuid)', 'EXECUTE')")" != "t" ]]; then
  echo "Failed overload replay unexpectedly mutated the leaked ACL" >&2
  exit 1
fi
psql_cmd -c 'DROP FUNCTION public.purge_deleted_account_group_edges(text)' >/dev/null
psql_cmd -f "$MIGRATION" >"$LOG_DIR/repaired-replay.log"

psql_cmd <<'SQL'
DO $replay_contract_exact$
BEGIN
  IF has_function_privilege(
    'authenticated',
    'public.purge_deleted_account_group_edges(uuid)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.purge_deleted_account_group_edges(uuid)',
    'EXECUTE'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_group_members_08_reject_inactive_account'
      AND trigger_info.tgqual IS NULL
      AND trigger_info.tgtype = 23
  ) THEN
    RAISE EXCEPTION 'clean replay did not restore exact ACL/trigger authority';
  END IF;
END
$replay_contract_exact$;
SQL

echo "Atomic deleted-account group purge PostgreSQL 17 proof passed"
