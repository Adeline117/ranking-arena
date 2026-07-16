#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the canonical group-dissolution boundary.
# It owns an isolated cluster, replays the migration through hostile ACL/policy
# drift, exercises rollback and permissions, and races two owner requests.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716175000_atomic_group_dissolution.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

if [[ ! -f "$MIGRATION" ]]; then
  echo "Atomic group dissolution migration is missing: $MIGRATION" >&2
  exit 1
fi

if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/group-dissolution-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=$((56000 + ($$ % 1000)))
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
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses= -c deadlock_timeout=100ms" \
  -w start >/dev/null

PSQL=(
  "$PG_BIN/psql"
  -X
  -v ON_ERROR_STOP=1
  -h "$SOCKET_DIR"
  -p "$PORT"
  -d postgres
)

"${PSQL[@]}" <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT;
CREATE ROLE drift_parent NOLOGIN;
CREATE ROLE drift_child NOLOGIN;
GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE;

ALTER SCHEMA public OWNER TO postgres;
GRANT USAGE ON SCHEMA public
  TO anon, authenticated, service_role, authenticator, drift_parent, drift_child;

SET ROLE postgres;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean DEFAULT false,
  ban_expires_at timestamptz
);

CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  dissolved_at timestamptz,
  member_count integer NOT NULL DEFAULT 0,
  drift_note text
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

-- A production database may already contain a dissolved row from the legacy
-- direct-update route.  Replay must preserve it and make later reopening fail.
INSERT INTO public.groups (id, name, created_by, dissolved_at) VALUES (
  '20000000-0000-4000-8000-000000000004',
  'Historical dissolution',
  '10000000-0000-4000-8000-000000000001',
  '2026-07-01T00:00:00+00'
);

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY legacy_group_policy ON public.groups FOR ALL TO PUBLIC
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON TABLE public.groups TO service_role;
GRANT SELECT, UPDATE ON TABLE public.groups TO authenticated;
GRANT UPDATE (dissolved_at) ON TABLE public.groups TO PUBLIC;
GRANT SELECT ON TABLE public.groups TO drift_parent WITH GRANT OPTION;
RESET ROLE;

SET ROLE drift_parent;
GRANT SELECT ON TABLE public.groups TO drift_child;
RESET ROLE;

SET ROLE postgres;
CREATE FUNCTION public.enforce_group_profile_edit_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_groups_06_guard_profile_edit
  BEFORE UPDATE OF name ON public.groups
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_group_profile_edit_write();

CREATE FUNCTION public.enforce_group_dissolution_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_groups_05_guard_dissolution
  BEFORE UPDATE OF dissolved_at ON public.groups
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_group_dissolution_write();

CREATE FUNCTION public.dissolve_group_atomic(
  p_actor_id uuid,
  p_group_id uuid
)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT '{"status":"legacy"}'::jsonb
$$;
GRANT EXECUTE ON FUNCTION public.dissolve_group_atomic(uuid, uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.dissolve_group_atomic(uuid, uuid)
  TO authenticated, drift_parent WITH GRANT OPTION;

-- Production-shaped account-purge repair: the current canonical function
-- updates member_count without touching dissolved_at.  The new trigger must
-- not block this independent maintenance path.
CREATE FUNCTION public.purge_deleted_account_group_edges(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_affected integer := 0;
BEGIN
  UPDATE public.groups AS target_group
  SET member_count = target_group.member_count + 1
  WHERE target_group.created_by = p_user_id
    AND target_group.dissolved_at IS NULL;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'purged',
    'groups_reconciled', v_affected
  );
END
$$;
REVOKE ALL ON FUNCTION public.purge_deleted_account_group_edges(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_deleted_account_group_edges(uuid) TO service_role;
RESET ROLE;
SQL

"${PSQL[@]}" -f "$MIGRATION" >/dev/null

# Reintroduce table, column, policy, trigger and function-ACL drift, including a
# newly added group column.  Replay must remove dependent grants with CASCADE
# and grant service update only to every non-dissolution column.
"${PSQL[@]}" <<'SQL'
SET ROLE postgres;
ALTER TABLE public.groups ADD COLUMN post_install_note text;
GRANT UPDATE ON TABLE public.groups TO service_role;
GRANT UPDATE (dissolved_at) ON TABLE public.groups TO authenticated WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.dissolve_group_atomic(uuid, uuid)
  TO authenticated WITH GRANT OPTION;
CREATE POLICY replay_drift ON public.groups FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);
CREATE TRIGGER replay_duplicate_dissolution_guard
  BEFORE UPDATE OF dissolved_at ON public.groups
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_group_dissolution_write();
RESET ROLE;

SET ROLE authenticated;
GRANT UPDATE (dissolved_at) ON TABLE public.groups TO drift_child;
GRANT EXECUTE ON FUNCTION public.dissolve_group_atomic(uuid, uuid) TO drift_child;
RESET ROLE;
SQL

# The canonical authenticator SET-only edge above must pass. A browser edge is
# unsafe migration drift: fail before changing objects, then pass once removed.
"${PSQL[@]}" -c 'GRANT service_role TO authenticated' >/dev/null
if "${PSQL[@]}" -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/unsafe-role.err"; then
  echo "Migration accepted an unsafe service_role authority edge" >&2
  exit 1
fi
if ! grep -q 'service_role has an unsafe effective authority edge' "$TMP_ROOT/unsafe-role.err"; then
  echo "Migration failed for an unexpected unsafe-role reason" >&2
  cat "$TMP_ROOT/unsafe-role.err" >&2
  exit 1
fi
"${PSQL[@]}" -c 'REVOKE service_role FROM authenticated' >/dev/null

# The gateway edge itself is allowed only as SET-only/NOINHERIT.  Prove that
# an inherited gateway edge also fails closed, then restore the canonical graph.
"${PSQL[@]}" -c \
  'GRANT service_role TO authenticator WITH INHERIT TRUE, SET TRUE' >/dev/null
if "${PSQL[@]}" -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/unsafe-authenticator.err"; then
  echo "Migration accepted an inherited authenticator service_role edge" >&2
  exit 1
fi
if ! grep -q 'service_role has an unsafe effective authority edge' \
  "$TMP_ROOT/unsafe-authenticator.err"; then
  echo "Migration failed for an unexpected authenticator-role reason" >&2
  cat "$TMP_ROOT/unsafe-authenticator.err" >&2
  exit 1
fi
"${PSQL[@]}" -c \
  'GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE' >/dev/null

# Prove recursive browser reachability is rejected too.  The direct
# authenticated -> bridge -> authenticator -> service_role SET chain must not
# be mistaken for the trusted gateway's own canonical edge.
"${PSQL[@]}" <<'SQL'
GRANT authenticator TO drift_parent WITH INHERIT FALSE, SET TRUE;
GRANT drift_parent TO authenticated WITH INHERIT FALSE, SET TRUE;
SQL
if "${PSQL[@]}" -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/unsafe-recursive-role.err"; then
  echo "Migration accepted a recursive browser-to-service_role authority edge" >&2
  exit 1
fi
if ! grep -q 'service_role has an unsafe effective authority edge' \
  "$TMP_ROOT/unsafe-recursive-role.err"; then
  echo "Migration failed for an unexpected recursive-role reason" >&2
  cat "$TMP_ROOT/unsafe-recursive-role.err" >&2
  exit 1
fi
"${PSQL[@]}" <<'SQL'
REVOKE drift_parent FROM authenticated;
REVOKE authenticator FROM drift_parent;
SQL

"${PSQL[@]}" -f "$MIGRATION" >/dev/null

"${PSQL[@]}" <<'SQL'
SET ROLE postgres;

CREATE FUNCTION public.expect_sqlstate(p_statement text, p_expected text)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_state text;
BEGIN
  BEGIN
    EXECUTE p_statement;
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      IF v_state = p_expected THEN
        RETURN;
      END IF;
      RAISE EXCEPTION 'expected SQLSTATE %, received %', p_expected, v_state;
  END;
  RAISE EXCEPTION 'statement unexpectedly succeeded: %', p_statement;
END
$function$;
GRANT EXECUTE ON FUNCTION public.expect_sqlstate(text, text)
  TO anon, authenticated, service_role;

INSERT INTO auth.users (id) VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000004');

INSERT INTO public.user_profiles (id, deleted_at) VALUES
  ('10000000-0000-4000-8000-000000000001', NULL),
  ('10000000-0000-4000-8000-000000000002', NULL),
  ('10000000-0000-4000-8000-000000000003', pg_catalog.clock_timestamp()),
  ('10000000-0000-4000-8000-000000000004', NULL);

INSERT INTO public.groups (id, name, created_by, dissolved_at) VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    'Atomic group',
    '10000000-0000-4000-8000-000000000001',
    NULL
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'Rollback group',
    '10000000-0000-4000-8000-000000000001',
    NULL
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    'Concurrent group',
    '10000000-0000-4000-8000-000000000001',
    NULL
  );

DO $assert_install$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.groups'::pg_catalog.regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgfoid =
        'public.enforce_group_dissolution_write()'::pg_catalog.regprocedure
  ) <> 1 THEN
    RAISE EXCEPTION 'replay retained a duplicate dissolution guard';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.groups'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_groups_06_guard_profile_edit'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'unrelated group profile guard was removed';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_audit_log'::pg_catalog.regclass
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_audit_log'::pg_catalog.regclass
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = constraint_row.conrelid
     AND attribute.attname = 'target_id'
     AND attribute.attnum = ANY(constraint_row.conkey)
    WHERE constraint_row.conrelid = 'public.group_audit_log'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
  ) THEN
    RAISE EXCEPTION 'audit NO FORCE/zero-policy/polymorphic-target fixture drifted';
  END IF;
  IF NOT pg_catalog.has_column_privilege(
    'service_role', 'public.groups', 'post_install_note', 'UPDATE'
  ) OR pg_catalog.has_column_privilege(
    'service_role', 'public.groups', 'dissolved_at', 'UPDATE'
  ) OR pg_catalog.has_column_privilege(
    'authenticated', 'public.groups', 'dissolved_at', 'UPDATE'
  ) OR pg_catalog.has_function_privilege(
    'drift_child', 'public.dissolve_group_atomic(uuid,uuid)', 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'migration replay did not converge dynamic authority drift';
  END IF;
END
$assert_install$;

-- The owner itself is still subject to the irreversible trigger.
SELECT public.expect_sqlstate(
  $$UPDATE public.groups
    SET dissolved_at = NULL
    WHERE id = '20000000-0000-4000-8000-000000000004'$$,
  '23514'
);
RESET ROLE;

SET ROLE authenticated;
DO $browser_read_contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.groups
    WHERE id = '20000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'browser SELECT capability was not preserved';
  END IF;
END
$browser_read_contract$;
SET request.jwt.claim.role = 'service_role';
SELECT public.expect_sqlstate(
  $$SELECT public.dissolve_group_atomic(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
  )$$,
  '42501'
);
SELECT public.expect_sqlstate(
  $$UPDATE public.groups
    SET name = 'forged'
    WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  '42501'
);
RESET ROLE;

SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
INSERT INTO public.groups (id, name, created_by) VALUES (
  '20000000-0000-4000-8000-000000000008',
  'Service-created active group',
  '10000000-0000-4000-8000-000000000001'
);
UPDATE public.groups
SET post_install_note = 'allowed service metadata update'
WHERE id = '20000000-0000-4000-8000-000000000001';
UPDATE public.groups
SET member_count = member_count + 1
WHERE id = '20000000-0000-4000-8000-000000000001';

DO $account_purge_count_repair$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.purge_deleted_account_group_edges(
    '10000000-0000-4000-8000-000000000001'
  );
  IF v_result ->> 'status' <> 'purged'
     OR (v_result ->> 'groups_reconciled')::integer < 1
  THEN
    RAISE EXCEPTION 'account-purge member_count repair was blocked: %', v_result;
  END IF;
END
$account_purge_count_repair$;
SELECT public.expect_sqlstate(
  $$UPDATE public.groups
    SET dissolved_at = pg_catalog.clock_timestamp()
    WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  '42501'
);
SELECT public.expect_sqlstate(
  $$INSERT INTO public.groups (id, name, created_by, dissolved_at)
    VALUES (
      '20000000-0000-4000-8000-000000000009',
      'Forged dissolved group',
      '10000000-0000-4000-8000-000000000001',
      pg_catalog.clock_timestamp()
    )$$,
  '23514'
);

DO $status_contract$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.dissolve_group_atomic(NULL, NULL);
  IF v_result <> '{"status":"invalid"}'::jsonb THEN
    RAISE EXCEPTION 'null dissolution request was admitted: %', v_result;
  END IF;

  v_result := public.dissolve_group_atomic(
    '10000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000001'
  );
  IF v_result <> '{"status":"actor_unavailable"}'::jsonb THEN
    RAISE EXCEPTION 'inactive actor was admitted: %', v_result;
  END IF;

  v_result := public.dissolve_group_atomic(
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001'
  );
  IF v_result <> '{"status":"forbidden"}'::jsonb THEN
    RAISE EXCEPTION 'non-owner was admitted: %', v_result;
  END IF;

  v_result := public.dissolve_group_atomic(
    '10000000-0000-4000-8000-000000000001',
    '29999999-0000-4000-8000-000000000001'
  );
  IF v_result <> '{"status":"not_found"}'::jsonb THEN
    RAISE EXCEPTION 'missing group status drifted: %', v_result;
  END IF;

  v_result := public.dissolve_group_atomic(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000004'
  );
  IF v_result ->> 'status' <> 'already_dissolved'
     OR (v_result ->> 'dissolved_at')::timestamptz <>
        '2026-07-01T00:00:00+00'::timestamptz
  THEN
    RAISE EXCEPTION 'historical dissolution was not idempotent: %', v_result;
  END IF;
END
$status_contract$;
RESET ROLE;
RESET request.jwt.claim.role;
SQL

# An audit failure must roll the group update back with it.
"${PSQL[@]}" <<'SQL'
SET ROLE postgres;
CREATE FUNCTION public.fail_test_dissolution_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.action = 'dissolve' THEN
    RAISE EXCEPTION 'test audit rejection';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_test_fail_dissolution_audit
  BEFORE INSERT ON public.group_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION public.fail_test_dissolution_audit();
RESET ROLE;

SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT public.expect_sqlstate(
  $$SELECT public.dissolve_group_atomic(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002'
  )$$,
  'P0001'
);
RESET ROLE;

SET ROLE postgres;
DO $rollback_assertion$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.groups
    WHERE id = '20000000-0000-4000-8000-000000000002'
      AND dissolved_at IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.group_audit_log
    WHERE group_id = '20000000-0000-4000-8000-000000000002'
      AND action = 'dissolve'
  ) THEN
    RAISE EXCEPTION 'audit failure left partial dissolution state';
  END IF;
END
$rollback_assertion$;
DROP TRIGGER trg_test_fail_dissolution_audit ON public.group_audit_log;
DROP FUNCTION public.fail_test_dissolution_audit();
RESET ROLE;
SQL

# Race two owner requests.  Whichever session wins must apply once; the waiter
# must observe the committed group row as already_dissolved, with one audit.
(
  "${PSQL[@]}" -Atq <<'SQL'
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
BEGIN;
SELECT (public.dissolve_group_atomic(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000003'
)) ->> 'status';
SELECT pg_catalog.pg_sleep(1);
COMMIT;
SQL
) >"$TMP_ROOT/race-one.out" &
RACE_ONE_PID=$!

(
  "${PSQL[@]}" -Atq <<'SQL'
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT (public.dissolve_group_atomic(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000003'
)) ->> 'status';
SQL
) >"$TMP_ROOT/race-two.out" &
RACE_TWO_PID=$!

wait "$RACE_ONE_PID"
wait "$RACE_TWO_PID"

RACE_RESULTS="$(tr '\n' ' ' <"$TMP_ROOT/race-one.out") $(tr '\n' ' ' <"$TMP_ROOT/race-two.out")"
if [[ "$(grep -o 'dissolved' <<<"$RACE_RESULTS" | wc -l | tr -d ' ')" != "2" ]] \
  || [[ "$(grep -o 'already_dissolved' <<<"$RACE_RESULTS" | wc -l | tr -d ' ')" != "1" ]]; then
  echo "Unexpected concurrent dissolution results: $RACE_RESULTS" >&2
  exit 1
fi

"${PSQL[@]}" <<'SQL'
SET ROLE postgres;
DO $final_assertions$
DECLARE
  v_first jsonb;
  v_second jsonb;
  v_dissolved_at timestamptz;
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.group_audit_log
    WHERE group_id = '20000000-0000-4000-8000-000000000003'
      AND actor_id = '10000000-0000-4000-8000-000000000001'
      AND action = 'dissolve'
      AND target_id = '20000000-0000-4000-8000-000000000003'
      AND details ->> 'group_name' = 'Concurrent group'
  ) <> 1 THEN
    RAISE EXCEPTION 'concurrent dissolution did not produce exactly one audit';
  END IF;

  SELECT target_group.dissolved_at
  INTO STRICT v_dissolved_at
  FROM public.groups AS target_group
  WHERE target_group.id = '20000000-0000-4000-8000-000000000003';
  IF v_dissolved_at IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.group_audit_log AS audit_row
    WHERE audit_row.group_id = '20000000-0000-4000-8000-000000000003'
      AND audit_row.created_at = v_dissolved_at
      AND (audit_row.details ->> 'dissolved_at')::timestamptz = v_dissolved_at
  ) THEN
    RAISE EXCEPTION 'dissolution state and audit timestamps diverged';
  END IF;
END
$final_assertions$;
RESET ROLE;

SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
DO $first_group_idempotency$
DECLARE
  v_first jsonb;
  v_second jsonb;
  v_first_time timestamptz;
BEGIN
  v_first := public.dissolve_group_atomic(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
  );
  v_second := public.dissolve_group_atomic(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
  );
  v_first_time := (v_first ->> 'dissolved_at')::timestamptz;

  IF v_first ->> 'status' <> 'dissolved'
     OR v_first ->> 'audit_log_id' IS NULL
     OR v_second ->> 'status' <> 'already_dissolved'
     OR (v_second ->> 'dissolved_at')::timestamptz <> v_first_time
  THEN
    RAISE EXCEPTION 'serial dissolution replay was not idempotent: %, %', v_first, v_second;
  END IF;
END
$first_group_idempotency$;
RESET ROLE;

SET ROLE postgres;
DO $serial_audit_assertion$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.group_audit_log
    WHERE group_id = '20000000-0000-4000-8000-000000000001'
      AND action = 'dissolve'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM public.groups AS target_group
    JOIN public.group_audit_log AS audit_row
      ON audit_row.group_id = target_group.id
     AND audit_row.created_at = target_group.dissolved_at
    WHERE target_group.id = '20000000-0000-4000-8000-000000000001'
      AND target_group.updated_at = target_group.dissolved_at
  ) THEN
    RAISE EXCEPTION 'serial dissolution state/audit contract failed';
  END IF;
END
$serial_audit_assertion$;
RESET ROLE;
SQL

echo "atomic group dissolution PG17 integration proof passed"
