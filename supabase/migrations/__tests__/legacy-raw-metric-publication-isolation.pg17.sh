#!/usr/bin/env bash

# PostgreSQL 17 disposable proof for the legacy raw-metric ACL/RLS cutover.
# It owns an isolated local cluster and never connects to application or remote
# database state.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20261111132450_legacy_raw_metric_publication_isolation_hosted_role_graph.sql"
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

TMP_ROOT="$(mktemp -d /tmp/legacy-raw-metric-publication-isolation-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if (( exit_code != 0 )) && [[ -f "$LOG_FILE" ]]; then
    echo "[legacy-raw-metric-publication-isolation] PostgreSQL log tail:" >&2
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

psql_as() {
  local role="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U "$role" -d postgres "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "[legacy-raw-metric-publication-isolation] $label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

expect_failure_as_contains() {
  local label="$1"
  local needle="$2"
  local role="$3"
  local sql="$4"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"

  if psql_as "$role" -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "[legacy-raw-metric-publication-isolation] Expected failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[legacy-raw-metric-publication-isolation] Unexpected failure for $label" >&2
    sed -n '1,220p' "$failure_log" >&2
    exit 1
  fi
}

expect_migration_failure() {
  local label="$1"
  local needle="$2"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"

  if psql_cmd -v VERBOSITY=verbose -f "$MIGRATION" >"$failure_log" 2>&1; then
    echo "[legacy-raw-metric-publication-isolation] Expected migration failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[legacy-raw-metric-publication-isolation] Unexpected migration failure for $label" >&2
    sed -n '1,260p' "$failure_log" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth=trust --username=postgres --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -k $SOCKET_DIR -p $PORT -c listen_addresses=''" -w start >/dev/null

echo "[legacy-raw-metric-publication-isolation] build historical browser-readable fixture"
psql_cmd -q <<'SQL'
CREATE ROLE anon LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
CREATE ROLE inherited_reader LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE setter_reader LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE setter_bridge NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE admin_bridge LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE delegated_reader LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE bypass_reader LOGIN NOINHERIT NOSUPERUSER BYPASSRLS;
CREATE ROLE hostile_owner LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;

GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA public
  TO anon, authenticated, service_role, authenticator, inherited_reader,
     setter_reader, setter_bridge, admin_bridge, delegated_reader, bypass_reader, hostile_owner;

CREATE TABLE public.trader_daily_snapshots (
  id bigint PRIMARY KEY,
  observed_at date NOT NULL DEFAULT DATE '2026-08-17',
  raw_value numeric NOT NULL
);
CREATE TABLE public.trader_equity_curve (
  id bigint PRIMARY KEY,
  observed_at date NOT NULL DEFAULT DATE '2026-08-17',
  raw_value numeric NOT NULL
);
CREATE TABLE public.trader_timeseries (
  id bigint NOT NULL,
  observed_at date NOT NULL,
  raw_value numeric NOT NULL
) PARTITION BY RANGE (observed_at);
CREATE TABLE public.trader_timeseries_y2026m08
  PARTITION OF public.trader_timeseries
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE public.trader_portfolio (
  id bigint PRIMARY KEY,
  observed_at date NOT NULL DEFAULT DATE '2026-08-17',
  raw_value numeric NOT NULL
);
CREATE TABLE public.trader_asset_breakdown (
  id bigint PRIMARY KEY,
  observed_at date NOT NULL DEFAULT DATE '2026-08-17',
  raw_value numeric NOT NULL
);
CREATE TABLE public.trader_stats_detail (
  id bigint PRIMARY KEY,
  observed_at date NOT NULL DEFAULT DATE '2026-08-17',
  raw_value numeric NOT NULL
);
CREATE TABLE public.trader_roi_history (
  id bigint PRIMARY KEY,
  observed_at date NOT NULL DEFAULT DATE '2026-08-17',
  raw_value numeric NOT NULL
);
CREATE TABLE public.trader_positions_live (
  id bigint PRIMARY KEY,
  observed_at date NOT NULL DEFAULT DATE '2026-08-17',
  raw_value numeric NOT NULL
);
CREATE TABLE public.trader_positions_history (
  id bigint PRIMARY KEY,
  observed_at date NOT NULL DEFAULT DATE '2026-08-17',
  raw_value numeric NOT NULL
);
CREATE TABLE public.trader_position_summary (
  id bigint PRIMARY KEY,
  observed_at date NOT NULL DEFAULT DATE '2026-08-17',
  raw_value numeric NOT NULL
);

-- Every root is deliberately browser-readable before cutover. The partition
-- child additionally has a column grant and a hostile non-postgres owner.
DO $fixture$
DECLARE
  v_relation regclass;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.trader_daily_snapshots'::regclass,
    'public.trader_equity_curve'::regclass,
    'public.trader_timeseries'::regclass,
    'public.trader_timeseries_y2026m08'::regclass,
    'public.trader_portfolio'::regclass,
    'public.trader_asset_breakdown'::regclass,
    'public.trader_stats_detail'::regclass,
    'public.trader_roi_history'::regclass,
    'public.trader_positions_live'::regclass,
    'public.trader_positions_history'::regclass,
    'public.trader_position_summary'::regclass
  ]::regclass[]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_relation);
    EXECUTE format('CREATE POLICY historical_public_read ON %s FOR SELECT TO public USING (true)', v_relation);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO PUBLIC, anon, authenticated, service_role', v_relation);
  END LOOP;
END
$fixture$;
GRANT SELECT (raw_value) ON public.trader_timeseries_y2026m08 TO authenticated;
ALTER TABLE public.trader_portfolio OWNER TO hostile_owner;

INSERT INTO public.trader_daily_snapshots(id, raw_value) VALUES (1, 11);
INSERT INTO public.trader_equity_curve(id, raw_value) VALUES (1, 22);
INSERT INTO public.trader_timeseries(id, observed_at, raw_value) VALUES (1, '2026-08-17', 33);
INSERT INTO public.trader_portfolio(id, raw_value) VALUES (1, 44);
INSERT INTO public.trader_asset_breakdown(id, raw_value) VALUES (1, 55);
INSERT INTO public.trader_stats_detail(id, raw_value) VALUES (1, 66);
INSERT INTO public.trader_roi_history(id, raw_value) VALUES (1, 77);
INSERT INTO public.trader_positions_live(id, raw_value) VALUES (1, 88);
INSERT INTO public.trader_positions_history(id, raw_value) VALUES (1, 99);
INSERT INTO public.trader_position_summary(id, raw_value) VALUES (1, 111);

-- A canonical and overload-like public RPC both read raw portfolio data.
CREATE FUNCTION public.legacy_raw_metric_reader()
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT raw_value FROM public.trader_portfolio WHERE id = 1
$function$;
CREATE FUNCTION public.legacy_raw_metric_reader(bigint)
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT raw_value FROM public.trader_daily_snapshots WHERE id = $1
$function$;
ALTER FUNCTION public.legacy_raw_metric_reader() OWNER TO hostile_owner;
ALTER FUNCTION public.legacy_raw_metric_reader(bigint) OWNER TO hostile_owner;
GRANT EXECUTE ON FUNCTION public.legacy_raw_metric_reader(), public.legacy_raw_metric_reader(bigint)
  TO PUBLIC, anon, authenticated, service_role;
SQL

assert_equal \
  "historical anonymous daily read" \
  "11" \
  "$(psql_as anon -Atqc 'SELECT raw_value FROM public.trader_daily_snapshots WHERE id = 1;')"
assert_equal \
  "historical authenticated partition child read" \
  "33" \
  "$(psql_as authenticated -Atqc 'SELECT raw_value FROM public.trader_timeseries_y2026m08 WHERE id = 1;')"
assert_equal \
  "historical anonymous raw function" \
  "44" \
  "$(psql_as anon -Atqc 'SELECT public.legacy_raw_metric_reader();')"

if [[ "${SUPABASE_MANAGED_GRAPH_PROOF:-0}" == "1" ]]; then
  # shellcheck source=lib/supabase-managed-graph-proof.sh
  source "$ROOT_DIR/supabase/migrations/__tests__/lib/supabase-managed-graph-proof.sh"
  if [[ "${SUPABASE_MANAGED_GRAPH_EXECUTOR:-}" == "hosted" ]]; then
    # hostile_owner is a bare-cluster attack fixture. A non-superuser executor
    # cannot take its objects over and fails closed instead, so the
    # hosted-executor path proves convergence with postgres-owned objects.
    psql_cmd -q <<'SQL'
ALTER TABLE public.trader_portfolio OWNER TO postgres;
ALTER FUNCTION public.legacy_raw_metric_reader() OWNER TO postgres;
ALTER FUNCTION public.legacy_raw_metric_reader(bigint) OWNER TO postgres;
SQL
  fi
  run_supabase_managed_graph_proof
  exit 0
fi

psql_cmd -q -f "$MIGRATION"

ROOT_RELATIONS=(
  trader_daily_snapshots
  trader_equity_curve
  trader_timeseries
  trader_portfolio
  trader_asset_breakdown
  trader_stats_detail
  trader_roi_history
  trader_positions_live
  trader_positions_history
  trader_position_summary
)
ALL_RELATIONS=("${ROOT_RELATIONS[@]}" trader_timeseries_y2026m08)

for relation in "${ALL_RELATIONS[@]}"; do
  expect_failure_as_contains \
    "anonymous-direct-${relation}" \
    "permission denied for table ${relation}" \
    "anon" \
    "SELECT * FROM public.${relation};"
  expect_failure_as_contains \
    "authenticated-direct-${relation}" \
    "permission denied for table ${relation}" \
    "authenticated" \
    "SELECT * FROM public.${relation};"
done

expect_failure_as_contains \
  "service-direct-child" \
  "permission denied for table trader_timeseries_y2026m08" \
  "authenticator" \
  "SET ROLE service_role; SELECT * FROM public.trader_timeseries_y2026m08;"
expect_failure_as_contains \
  "former-owner-direct-read" \
  "permission denied for table trader_portfolio" \
  "hostile_owner" \
  "SELECT * FROM public.trader_portfolio;"
expect_failure_as_contains \
  "bypass-rls-without-acl-direct-read" \
  "permission denied for table trader_portfolio" \
  "bypass_reader" \
  "SELECT * FROM public.trader_portfolio;"

expect_failure_as_contains \
  "anonymous-canonical-raw-rpc" \
  "permission denied for function legacy_raw_metric_reader" \
  "anon" \
  "SELECT public.legacy_raw_metric_reader();"
expect_failure_as_contains \
  "authenticated-overload-raw-rpc" \
  "permission denied for function legacy_raw_metric_reader" \
  "authenticated" \
  "SELECT public.legacy_raw_metric_reader(1);"

# The canonical gateway is the only valid SET ROLE path. It retains parent
# service CRUD, including routing through the partitioned timeseries parent.
for relation in "${ROOT_RELATIONS[@]}"; do
  assert_equal \
    "service parent read ${relation}" \
    "1" \
    "$(psql_as authenticator -Atqc "SET ROLE service_role; SELECT count(*) FROM public.${relation};")"
done
psql_as authenticator -q <<'SQL'
SET ROLE service_role;
INSERT INTO public.trader_daily_snapshots(id, raw_value) VALUES (2, 1);
UPDATE public.trader_daily_snapshots SET raw_value = 2 WHERE id = 2;
DELETE FROM public.trader_daily_snapshots WHERE id = 2;
INSERT INTO public.trader_timeseries(id, observed_at, raw_value) VALUES (2, '2026-08-18', 1);
UPDATE public.trader_timeseries SET raw_value = 2 WHERE id = 2;
DELETE FROM public.trader_timeseries WHERE id = 2;
SELECT public.legacy_raw_metric_reader();
SELECT public.legacy_raw_metric_reader(1);
SQL

# New children must be converged after the migration too. Hostile defaults are
# applied during CREATE TABLE; a separately created child additionally proves
# that ATTACH PARTITION cannot preserve a policy or ACL bypass.
psql_cmd -q <<'SQL'
BEGIN;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON TABLES TO PUBLIC, anon, authenticated, service_role;
CREATE TABLE public.trader_timeseries_y2026m09
  PARTITION OF public.trader_timeseries
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE public.trader_timeseries_y2026m10
  (LIKE public.trader_timeseries INCLUDING ALL);
GRANT SELECT ON public.trader_timeseries_y2026m10 TO PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.trader_timeseries_y2026m10 ENABLE ROW LEVEL SECURITY;
CREATE POLICY hostile_direct_read ON public.trader_timeseries_y2026m10
  FOR SELECT TO PUBLIC USING (true);
ALTER TABLE public.trader_timeseries
  ATTACH PARTITION public.trader_timeseries_y2026m10
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT ON TABLES FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
SQL
for relation in trader_timeseries_y2026m09 trader_timeseries_y2026m10; do
  expect_failure_as_contains \
    "anonymous-future-${relation}" \
    "permission denied for table ${relation}" \
    "anon" \
    "SELECT * FROM public.${relation};"
  expect_failure_as_contains \
    "service-future-${relation}" \
    "permission denied for table ${relation}" \
    "authenticator" \
    "SET ROLE service_role; SELECT * FROM public.${relation};"
done

psql_cmd -q <<'SQL'
DO $assertions$
DECLARE
  v_relation record;
  v_privilege text;
BEGIN
  FOR v_relation IN
    SELECT relation.oid, relation.relname, relation.relkind, relation.relowner, relation.relrowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = ANY (ARRAY[
      'public.trader_daily_snapshots'::regclass::oid,
      'public.trader_equity_curve'::regclass::oid,
      'public.trader_timeseries'::regclass::oid,
      'public.trader_timeseries_y2026m08'::regclass::oid,
      'public.trader_portfolio'::regclass::oid,
      'public.trader_asset_breakdown'::regclass::oid,
      'public.trader_stats_detail'::regclass::oid,
      'public.trader_roi_history'::regclass::oid,
      'public.trader_positions_live'::regclass::oid,
      'public.trader_positions_history'::regclass::oid,
      'public.trader_position_summary'::regclass::oid
    ]::oid[])
  LOOP
    IF v_relation.relowner <> 'postgres'::regrole OR NOT v_relation.relrowsecurity THEN
      RAISE EXCEPTION '% did not converge to postgres-owned RLS', v_relation.relname;
    END IF;

    IF v_relation.relname = 'trader_timeseries_y2026m08' THEN
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = v_relation.oid)
         OR EXISTS (
           SELECT 1
           FROM pg_catalog.pg_class AS relation
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
           ) AS privilege
           WHERE relation.oid = v_relation.oid
             AND privilege.grantee <> relation.relowner
         ) THEN
        RAISE EXCEPTION 'partition child retained direct policy or ACL';
      END IF;
    ELSE
      IF (
           SELECT count(*) FROM pg_catalog.pg_policy
           WHERE polrelid = v_relation.oid
         ) <> 1 OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_policy AS policy
           WHERE policy.polrelid = v_relation.oid
             AND policy.polname = 'raw_legacy_metric_service_only'
             AND policy.polcmd = '*'
             AND policy.polroles = ARRAY['service_role'::regrole]::oid[]
             AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
             AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
         ) THEN
        RAISE EXCEPTION '% service-only policy did not converge', v_relation.relname;
      END IF;
    END IF;

    FOR v_privilege IN SELECT unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[])
    LOOP
      IF pg_catalog.has_table_privilege('anon', v_relation.oid, v_privilege)
         OR pg_catalog.has_table_privilege('authenticated', v_relation.oid, v_privilege) THEN
        RAISE EXCEPTION '% remains browser-readable by %', v_relation.relname, v_privilege;
      END IF;
    END LOOP;

    IF EXISTS (
         SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
         CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
         WHERE attribute.attrelid = v_relation.oid
           AND attribute.attacl IS NOT NULL
           AND privilege.grantee <> 'postgres'::regrole
       ) THEN
      RAISE EXCEPTION '% retained a non-owner column grant', v_relation.relname;
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege('anon', 'public.legacy_raw_metric_reader()'::regprocedure, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.legacy_raw_metric_reader(bigint)'::regprocedure, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', 'public.legacy_raw_metric_reader()'::regprocedure, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', 'public.legacy_raw_metric_reader(bigint)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'raw metric function ACL did not converge';
  END IF;
END
$assertions$;
SQL

# An inherited reader reaches service-only data before replay; the migration
# must reject the graph rather than claim the table ACL is sufficient.
psql_cmd -q -c "GRANT service_role TO inherited_reader WITH INHERIT TRUE, SET FALSE"
assert_equal \
  "inherited reader reaches raw data before rejection" \
  "1" \
  "$(psql_as inherited_reader -Atqc 'SELECT count(*) FROM public.trader_daily_snapshots;')"
expect_migration_failure \
  "inherited-service-role-reader" \
  "legacy raw metric service authority graph is unsafe"
psql_cmd -q -c "REVOKE service_role FROM inherited_reader"

# Multi-hop SET through the gateway and ADMIN delegation are capability paths,
# even though neither directly inherits service_role.
psql_cmd -q <<'SQL'
GRANT authenticator TO setter_bridge WITH INHERIT FALSE, SET TRUE;
GRANT setter_bridge TO setter_reader WITH INHERIT FALSE, SET TRUE;
SQL
assert_equal \
  "multi-hop SET reader reaches raw data before rejection" \
  "1" \
  "$(psql_as setter_reader -Atqc 'SET ROLE setter_bridge; SET ROLE authenticator; SET ROLE service_role; SELECT count(*) FROM public.trader_daily_snapshots;')"
expect_migration_failure \
  "multi-hop-set-reader" \
  "legacy raw metric service authority graph is unsafe"
psql_cmd -q <<'SQL'
REVOKE setter_bridge FROM setter_reader;
REVOKE authenticator FROM setter_bridge;
GRANT authenticator TO admin_bridge WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
SQL
expect_migration_failure \
  "admin-only-gateway-delegator" \
  "legacy raw metric service authority graph is unsafe"
psql_as admin_bridge -q -c "GRANT authenticator TO delegated_reader WITH INHERIT FALSE, SET TRUE"
assert_equal \
  "delegated ADMIN path reaches raw data before rejection" \
  "1" \
  "$(psql_as delegated_reader -Atqc 'SET ROLE authenticator; SET ROLE service_role; SELECT count(*) FROM public.trader_daily_snapshots;')"
psql_as admin_bridge -q -c "REVOKE authenticator FROM delegated_reader"
psql_cmd -q -c "REVOKE authenticator FROM admin_bridge"

# Replay after every hostile edge is removed must remain idempotent and keep
# the attached partition directly inaccessible to browser and service roles.
psql_cmd -q -f "$MIGRATION"
expect_failure_as_contains \
  "inherited-reader-denied-after-replay" \
  "permission denied for table trader_daily_snapshots" \
  "inherited_reader" \
  "SELECT * FROM public.trader_daily_snapshots;"
expect_failure_as_contains \
  "setter-reader-denied-after-replay" \
  "permission denied for table trader_daily_snapshots" \
  "setter_reader" \
  "SELECT * FROM public.trader_daily_snapshots;"
expect_failure_as_contains \
  "delegated-reader-denied-after-replay" \
  "permission denied for table trader_daily_snapshots" \
  "delegated_reader" \
  "SELECT * FROM public.trader_daily_snapshots;"

echo "[legacy-raw-metric-publication-isolation] PostgreSQL 17 proof passed"
