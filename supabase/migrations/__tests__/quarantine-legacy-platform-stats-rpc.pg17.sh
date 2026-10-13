#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for quarantining every legacy
# get_platform_stats function overload. It owns an isolated temporary cluster
# and never contacts an external database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260817134214_quarantine_legacy_platform_stats_rpc.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

if [[ ! -f "$MIGRATION" ]]; then
  echo "Migration not found: $MIGRATION" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/legacy-platform-stats-rpc-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 1000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if (( exit_code != 0 )) && [[ -f "$LOG_FILE" ]]; then
    echo "[legacy-platform-stats-rpc] PostgreSQL log tail:" >&2
    tail -160 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

expect_migration_failure() {
  local label="$1"
  local needle="$2"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"

  if psql_cmd -v VERBOSITY=verbose -f "$MIGRATION" >"$failure_log" 2>&1; then
    echo "[legacy-platform-stats-rpc] Expected migration failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[legacy-platform-stats-rpc] Unexpected migration failure for $label" >&2
    sed -n '1,180p' "$failure_log" >&2
    exit 1
  fi
}

expect_role_denied() {
  local label="$1"
  local role="$2"
  local sql="$3"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"

  if psql_cmd -v VERBOSITY=verbose -c "SET ROLE \"$role\"; $sql" >"$failure_log" 2>&1; then
    echo "[legacy-platform-stats-rpc] Expected denied call: $label" >&2
    exit 1
  fi
  if ! grep -Fq 'permission denied for function get_platform_stats' "$failure_log"; then
    echo "[legacy-platform-stats-rpc] Unexpected denied-call failure for $label" >&2
    sed -n '1,180p' "$failure_log" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --username=postgres \
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
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
SQL

# The migration must not record a false-safe success if production no longer
# contains the legacy RPC it is meant to quarantine.
expect_migration_failure \
  'no-live-overload-fails-closed' \
  'requires at least one public.get_platform_stats function overload'

psql_cmd <<'SQL'
CREATE FUNCTION public.get_platform_stats(p_season_id text)
RETURNS TABLE (
  platform text,
  trader_count integer
)
LANGUAGE sql
STABLE
AS $$
  SELECT p_season_id, 1
$$;

CREATE FUNCTION public.get_platform_stats(
  p_season_id text,
  p_include_archived boolean
)
RETURNS TABLE (
  platform text,
  trader_count integer
)
LANGUAGE sql
STABLE
AS $$
  SELECT p_season_id || CASE WHEN p_include_archived THEN ':all' ELSE ':live' END, 2
$$;

GRANT EXECUTE ON FUNCTION public.get_platform_stats(text)
  TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_platform_stats(text, boolean)
  TO PUBLIC, anon, authenticated, service_role;

DO $assert_fixture$
DECLARE
  function_oid oid;
  application_role name;
BEGIN
  IF (
    SELECT COUNT(*)
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = procedure.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND procedure.proname = 'get_platform_stats'
      AND procedure.prokind = 'f'
  ) <> 2 THEN
    RAISE EXCEPTION 'fixture did not create exactly two get_platform_stats overloads';
  END IF;

  FOREACH application_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[]
  LOOP
    FOR function_oid IN
      SELECT procedure.oid
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace_row
        ON namespace_row.oid = procedure.pronamespace
      WHERE namespace_row.nspname = 'public'
        AND procedure.proname = 'get_platform_stats'
        AND procedure.prokind = 'f'
    LOOP
      IF NOT pg_catalog.has_function_privilege(application_role, function_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'hostile fixture did not grant % execute on %',
          application_role,
          function_oid::pg_catalog.regprocedure;
      END IF;
    END LOOP;
  END LOOP;
END;
$assert_fixture$;
SQL

# The second apply proves repeated deployment does not re-open an ACL or alter
# an overload body/signature.
psql_cmd -f "$MIGRATION" >/dev/null
echo '[legacy-platform-stats-rpc] prove replay stability'
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $assert_quarantine$
DECLARE
  function_oid oid;
  application_role name;
BEGIN
  IF (
    SELECT COUNT(*)
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = procedure.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND procedure.proname = 'get_platform_stats'
      AND procedure.prokind = 'f'
  ) <> 2 THEN
    RAISE EXCEPTION 'migration unexpectedly dropped or rewrote a get_platform_stats overload';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    WHERE namespace_row.nspname = 'public'
      AND procedure.proname = 'get_platform_stats'
      AND procedure.prokind = 'f'
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC can still execute a get_platform_stats overload';
  END IF;

  FOREACH application_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[]
  LOOP
    FOR function_oid IN
      SELECT procedure.oid
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace_row
        ON namespace_row.oid = procedure.pronamespace
      WHERE namespace_row.nspname = 'public'
        AND procedure.proname = 'get_platform_stats'
        AND procedure.prokind = 'f'
    LOOP
      IF pg_catalog.has_function_privilege(application_role, function_oid, 'EXECUTE') THEN
        RAISE EXCEPTION '% can still execute %',
          application_role,
          function_oid::pg_catalog.regprocedure;
      END IF;
    END LOOP;
  END LOOP;
END;
$assert_quarantine$;
SQL

expect_role_denied \
  'anon-text-overload-denied' \
  anon \
  "SELECT * FROM public.get_platform_stats('90D');"
expect_role_denied \
  'anon-two-argument-overload-denied' \
  anon \
  "SELECT * FROM public.get_platform_stats('90D', false);"
expect_role_denied \
  'authenticated-text-overload-denied' \
  authenticated \
  "SELECT * FROM public.get_platform_stats('90D');"
expect_role_denied \
  'authenticated-two-argument-overload-denied' \
  authenticated \
  "SELECT * FROM public.get_platform_stats('90D', false);"
expect_role_denied \
  'service-role-text-overload-denied' \
  service_role \
  "SELECT * FROM public.get_platform_stats('90D');"
expect_role_denied \
  'service-role-two-argument-overload-denied' \
  service_role \
  "SELECT * FROM public.get_platform_stats('90D', false);"

echo 'legacy platform-stats RPC quarantine PostgreSQL 17 proof passed'
