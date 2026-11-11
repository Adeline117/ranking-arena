# shellcheck shell=bash
# Shared production-graph proof for the 2026-08-17 role-graph guards.
#
# Sourced by a migration's PostgreSQL 17 proof when
# SUPABASE_MANAGED_GRAPH_PROOF=1, at the point where its own fixture is ready
# for the first successful apply. It overlays the Supabase-managed role
# memberships observed on the hosted project, proves that the guard still
# rejects any widening of those managed edges, and then requires the
# migration to apply on the real hosted graph. The caller exits afterwards
# because its own later assertions model a bare cluster without those edges.
#
# Requires the caller's psql_cmd, MIGRATION, and ROOT_DIR.
#
# With SUPABASE_MANAGED_GRAPH_EXECUTOR=hosted the caller's cluster must have
# been bootstrapped by a separate supabase_admin superuser. Fixture and attack
# setup then run as supabase_admin, postgres is demoted to the hosted
# project's non-superuser attributes, and every migration attempt runs as that
# non-superuser postgres, matching the hosted migration executor.

supabase_managed_graph_admin() {
  if [[ "${SUPABASE_MANAGED_GRAPH_EXECUTOR:-}" == "hosted" ]]; then
    "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
      -h "$SOCKET_DIR" -p "$PORT" -U supabase_admin -d postgres "$@"
  else
    psql_cmd "$@"
  fi
}

supabase_managed_graph_migrate() {
  if [[ "${SUPABASE_MANAGED_GRAPH_EXECUTOR:-}" == "hosted" ]]; then
    "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
      -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
  else
    psql_cmd "$@"
  fi
}

supabase_managed_graph_expect_failure() {
  local label="$1"
  local expected="$2"
  local log
  log="$(mktemp)"
  if supabase_managed_graph_migrate -v VERBOSITY=verbose -f "$MIGRATION" >"$log" 2>&1; then
    echo "[supabase-managed-graph] $label: migration unexpectedly applied" >&2
    rm -f "$log"
    exit 1
  fi
  if [[ -n "$expected" ]] && ! grep -Fq "$expected" "$log"; then
    echo "[supabase-managed-graph] $label: expected '$expected'" >&2
    cat "$log" >&2
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"
}

run_supabase_managed_graph_proof() {
  local fixture="$ROOT_DIR/supabase/migrations/__tests__/fixtures/supabase-managed-role-graph.pg17.psql"
  local precondition='Supabase-managed login roles must not be enterable or privileged'

  echo "[supabase-managed-graph] overlay hosted Supabase role graph"
  supabase_managed_graph_admin -q -f "$fixture" >/dev/null
  if [[ "${SUPABASE_MANAGED_GRAPH_EXECUTOR:-}" == "hosted" ]]; then
    echo "[supabase-managed-graph] demote postgres to the hosted executor"
    supabase_managed_graph_admin -q -c \
      'ALTER ROLE postgres NOSUPERUSER CREATEROLE CREATEDB REPLICATION BYPASSRLS LOGIN INHERIT'
    # On the hosted project postgres owns the database, so pg_database_owner
    # (the default public schema owner) resolves to postgres.
    supabase_managed_graph_admin -q -c 'ALTER DATABASE postgres OWNER TO postgres'
  fi

  # 1. Anyone entering a managed bridge inherits its exempted edge.
  supabase_managed_graph_admin -q -c 'CREATE ROLE managed_bridge_intruder LOGIN NOINHERIT'
  supabase_managed_graph_admin -q -c 'GRANT cli_login_postgres TO managed_bridge_intruder WITH INHERIT FALSE, SET TRUE'
  supabase_managed_graph_expect_failure 'member of cli_login_postgres' "$precondition"
  supabase_managed_graph_admin -q -c 'REVOKE cli_login_postgres FROM managed_bridge_intruder'
  supabase_managed_graph_admin -q -c 'GRANT supabase_storage_admin TO managed_bridge_intruder WITH INHERIT FALSE, SET TRUE'
  supabase_managed_graph_expect_failure 'member of supabase_storage_admin' "$precondition"
  supabase_managed_graph_admin -q -c 'REVOKE supabase_storage_admin FROM managed_bridge_intruder'
  supabase_managed_graph_admin -q -c 'DROP ROLE managed_bridge_intruder'

  # 2. A managed bridge with any extra attribute is no longer the platform role.
  supabase_managed_graph_admin -q -c 'ALTER ROLE cli_login_postgres BYPASSRLS'
  supabase_managed_graph_expect_failure 'privileged cli_login_postgres' "$precondition"
  supabase_managed_graph_admin -q -c 'ALTER ROLE cli_login_postgres NOBYPASSRLS'
  supabase_managed_graph_admin -q -c 'ALTER ROLE supabase_storage_admin INHERIT'
  supabase_managed_graph_expect_failure 'inheriting supabase_storage_admin' "$precondition"
  supabase_managed_graph_admin -q -c 'ALTER ROLE supabase_storage_admin NOINHERIT'

  # 3. A managed bridge holding any second edge is rejected.
  supabase_managed_graph_admin -q -c 'GRANT pg_read_all_data TO cli_login_postgres WITH INHERIT FALSE, SET TRUE'
  supabase_managed_graph_expect_failure 'cli_login_postgres second edge' "$precondition"
  supabase_managed_graph_admin -q -c 'REVOKE pg_read_all_data FROM cli_login_postgres'

  # 4. Widening the exempted edge itself falls back to the original guard.
  supabase_managed_graph_admin -q -c 'GRANT postgres TO cli_login_postgres WITH INHERIT TRUE'
  supabase_managed_graph_expect_failure 'inheriting cli_login_postgres edge' ''
  supabase_managed_graph_admin -q -c 'GRANT postgres TO cli_login_postgres WITH INHERIT FALSE'

  echo "[supabase-managed-graph] apply on hosted role graph"
  supabase_managed_graph_migrate -q -f "$MIGRATION" >/dev/null

  if [[ "$(supabase_managed_graph_migrate -Atqc "SELECT pg_catalog.to_regclass('pg_temp.arena_guard_auth_members') IS NULL")" != "t" ]]; then
    echo "[supabase-managed-graph] guard edge table outlived the migration" >&2
    exit 1
  fi
  echo "[supabase-managed-graph] proof passed"
}
