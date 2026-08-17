#!/usr/bin/env bash

# PostgreSQL 17 disposable proof for the raw trader-series publication
# isolation. It owns an isolated cluster and never connects to application or
# remote database state.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260817060000_trader_series_publication_isolation.sql"
PARTITION_CONVERGENCE="$ROOT_DIR/supabase/migrations/20260718135000_partition_child_rls_convergence.sql"
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
if [[ ! -f "$PARTITION_CONVERGENCE" ]]; then
  echo "Partition convergence prerequisite not found: $PARTITION_CONVERGENCE" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/trader-series-publication-isolation-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((62000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if (( exit_code != 0 )) && [[ -f "$LOG_FILE" ]]; then
    echo "[trader-series-publication-isolation] PostgreSQL log tail:" >&2
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
    echo "[trader-series-publication-isolation] $label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

expect_failure_contains() {
  local label="$1"
  local needle="$2"
  local sql="$3"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"

  if psql_cmd -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "[trader-series-publication-isolation] Expected failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[trader-series-publication-isolation] Unexpected failure for $label" >&2
    sed -n '1,220p' "$failure_log" >&2
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
    echo "[trader-series-publication-isolation] Expected failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[trader-series-publication-isolation] Unexpected failure for $label" >&2
    sed -n '1,220p' "$failure_log" >&2
    exit 1
  fi
}

expect_migration_failure() {
  local label="$1"
  local needle="$2"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"

  if psql_cmd -v VERBOSITY=verbose -f "$MIGRATION" >"$failure_log" 2>&1; then
    echo "[trader-series-publication-isolation] Expected migration failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[trader-series-publication-isolation] Unexpected migration failure for $label" >&2
    sed -n '1,260p' "$failure_log" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth=trust --username=postgres --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -k $SOCKET_DIR -p $PORT -c listen_addresses=''" -w start >/dev/null

echo "[trader-series-publication-isolation] build historical browser-readable fixture"
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

GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE;

CREATE SCHEMA arena AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, arena
  TO anon, authenticated, service_role, authenticator, inherited_reader,
     setter_reader, setter_bridge, admin_bridge, delegated_reader;

CREATE TABLE arena.trader_series (
  source text NOT NULL,
  trader_key text NOT NULL,
  observed_at timestamptz NOT NULL,
  value numeric NOT NULL
) PARTITION BY RANGE (observed_at);
CREATE TABLE arena.trader_series_y2026m08
  PARTITION OF arena.trader_series
  FOR VALUES FROM ('2026-08-01T00:00:00.000Z') TO ('2026-09-01T00:00:00.000Z');
CREATE TABLE arena.trader_series_weekly (
  source text NOT NULL,
  trader_key text NOT NULL,
  observed_at timestamptz NOT NULL,
  value numeric NOT NULL
);
-- These partition parents are the prerequisite surface of the production
-- future-child converger. Their simple fixture shapes are enough because the
-- helper only reasons about parent/child metadata and partition bounds.
CREATE TABLE arena.leaderboard_entries (observed_at timestamptz NOT NULL)
  PARTITION BY RANGE (observed_at);
CREATE TABLE arena.position_history (observed_at timestamptz NOT NULL)
  PARTITION BY RANGE (observed_at);
CREATE TABLE arena.order_records (observed_at timestamptz NOT NULL)
  PARTITION BY RANGE (observed_at);
CREATE TABLE arena.transfer_history (observed_at timestamptz NOT NULL)
  PARTITION BY RANGE (observed_at);
CREATE TABLE arena.copier_records (observed_at timestamptz NOT NULL)
  PARTITION BY RANGE (observed_at);

ALTER TABLE arena.trader_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.trader_series_y2026m08 ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.trader_series_weekly ENABLE ROW LEVEL SECURITY;
CREATE POLICY trader_series_historical_public ON arena.trader_series
  FOR SELECT TO public USING (true);
CREATE POLICY trader_series_child_historical_public ON arena.trader_series_y2026m08
  FOR SELECT TO public USING (true);
CREATE POLICY trader_series_weekly_historical_public ON arena.trader_series_weekly
  FOR SELECT TO public USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON arena.trader_series
  TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON arena.trader_series_y2026m08
  TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON arena.trader_series_weekly
  TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT (value) ON arena.trader_series_y2026m08 TO authenticated;

INSERT INTO arena.trader_series(source, trader_key, observed_at, value) VALUES
  ('binance_futures', 'seed', '2026-08-17T00:00:00.000Z', 81.25);
INSERT INTO arena.trader_series_weekly(source, trader_key, observed_at, value) VALUES
  ('binance_futures', 'seed', '2026-08-17T00:00:00.000Z', 81.25);

CREATE FUNCTION public.arena_roi_sparklines(jsonb, integer, integer)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.jsonb_build_object('roi', 81.25, 'series', '[{"ts":1,"value":81.25}]'::jsonb)
$function$;
CREATE FUNCTION public.arena_core_modules(text, text, integer)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.jsonb_build_object('stats', pg_catalog.jsonb_build_object('pnl', 9000), 'series', '[{"ts":1,"value":81.25}]'::jsonb, 'extras', pg_catalog.jsonb_build_object('pnl_calendar', '[1,2,3]'::jsonb))
$function$;
CREATE FUNCTION public.snapshot_score_backtest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  RETURN;
END
$function$;
CREATE FUNCTION public.evaluate_score_backtest(integer)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.jsonb_build_object('score', $1)
$function$;

-- phantom core overload and phantom sparkline overload are deliberately
-- browser-executable before the cutover. The migration must close every
-- public overload rather than merely canonical route signatures.
CREATE FUNCTION public.arena_core_modules(text, text, bigint)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.jsonb_build_object('pnl', 12345)
$function$;
CREATE FUNCTION public.arena_roi_sparklines(jsonb, bigint, integer)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.jsonb_build_object('roi', 99.9)
$function$;
CREATE FUNCTION public.snapshot_score_backtest(integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  RETURN;
END
$function$;
CREATE FUNCTION public.evaluate_score_backtest(bigint)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.jsonb_build_object('phantom_score', $1)
$function$;

GRANT EXECUTE ON FUNCTION public.arena_roi_sparklines(jsonb, integer, integer),
  public.arena_roi_sparklines(jsonb, bigint, integer),
  public.arena_core_modules(text, text, integer),
  public.arena_core_modules(text, text, bigint),
  public.snapshot_score_backtest(),
  public.snapshot_score_backtest(integer),
  public.evaluate_score_backtest(integer),
  public.evaluate_score_backtest(bigint)
  TO PUBLIC, anon, authenticated, service_role;

-- Bootstrap only: the next historical migration replaces this with the real
-- production monthly child converger before this proof invokes it.
CREATE FUNCTION arena.ensure_month_partitions(
  parent_table text,
  months_ahead integer DEFAULT 2,
  months_back integer DEFAULT 0
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_month date := (pg_catalog.date_trunc('month', pg_catalog.statement_timestamp()) + interval '1 month')::date;
  v_name text;
BEGIN
  IF parent_table <> 'trader_series' THEN
    RAISE EXCEPTION 'unsupported parent';
  END IF;
  v_name := pg_catalog.format('trader_series_y%sm%s', pg_catalog.to_char(v_month, 'YYYY'), pg_catalog.to_char(v_month, 'MM'));
  EXECUTE pg_catalog.format(
    'CREATE TABLE IF NOT EXISTS arena.%I PARTITION OF arena.trader_series FOR VALUES FROM (%L) TO (%L)',
    v_name, v_month, (v_month + interval '1 month')::date
  );
  EXECUTE pg_catalog.format('ALTER TABLE arena.%I OWNER TO postgres', v_name);
  EXECUTE pg_catalog.format('ALTER TABLE arena.%I ENABLE ROW LEVEL SECURITY', v_name);
  EXECUTE pg_catalog.format('REVOKE ALL ON TABLE arena.%I FROM PUBLIC, anon, authenticated, service_role', v_name);
  RETURN 1;
END
$function$;
ALTER FUNCTION arena.ensure_month_partitions(text, integer, integer) OWNER TO postgres;
SQL

# Exercise the real pre-existing partition convergence migration, then restore
# a deliberately hostile historical child ACL/policy so 60000 must collapse it
# again. Future-child assertions below therefore execute the production helper,
# not a compact mock.
psql_cmd -q -f "$PARTITION_CONVERGENCE"
psql_cmd -q <<'SQL'
CREATE POLICY trader_series_child_historical_public ON arena.trader_series_y2026m08
  FOR SELECT TO public USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON arena.trader_series_y2026m08
  TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT (value) ON arena.trader_series_y2026m08 TO authenticated;
SQL

# Historical browser-readable fixture: raw parent/child/weekly data and both
# direct raw RPC families are accessible before the new boundary.
assert_equal \
  "historical anonymous raw parent read" \
  "1" \
  "$(psql_as anon -Atqc 'SELECT count(*) FROM arena.trader_series;')"
assert_equal \
  "historical authenticated child read" \
  "1" \
  "$(psql_as authenticated -Atqc 'SELECT count(*) FROM arena.trader_series_y2026m08;')"
assert_equal \
  "historical anonymous core RPC" \
  "12345" \
  "$(psql_as anon -Atqc "SELECT (public.arena_core_modules('binance_futures', 'seed', 90::bigint)->>'pnl')::integer;")"
assert_equal \
  "historical anonymous sparkline RPC" \
  "99.9" \
  "$(psql_as anon -Atqc "SELECT public.arena_roi_sparklines('{}'::jsonb, 90::bigint, 1)->>'roi';")"

psql_cmd -q -f "$MIGRATION"

# Canonical gateway still has the sole trusted SET-only service path, but it
# has no direct raw-table grant itself.
assert_equal \
  "canonical gateway service parent read" \
  "1" \
  "$(psql_as authenticator -Atqc 'SET ROLE service_role; SELECT count(*) FROM arena.trader_series;')"
expect_failure_as_contains \
  "canonical-gateway-direct-parent-read" \
  "permission denied for table trader_series" \
  "authenticator" \
  "SELECT * FROM arena.trader_series;"

# anonymous direct SELECT is denied
expect_failure_as_contains \
  "anonymous-direct-select" \
  "permission denied for table trader_series" \
  "anon" \
  "SELECT * FROM arena.trader_series;"
# authenticated direct SELECT is denied
expect_failure_as_contains \
  "authenticated-direct-select" \
  "permission denied for table trader_series_y2026m08" \
  "authenticated" \
  "SELECT * FROM arena.trader_series_y2026m08;"
expect_failure_as_contains \
  "service-direct-existing-child-read" \
  "permission denied for table trader_series_y2026m08" \
  "authenticator" \
  "SET ROLE service_role; SELECT * FROM arena.trader_series_y2026m08;"
expect_failure_as_contains \
  "anonymous-weekly-direct-select" \
  "permission denied for table trader_series_weekly" \
  "anon" \
  "SELECT * FROM arena.trader_series_weekly;"
expect_failure_as_contains \
  "authenticated-weekly-direct-select" \
  "permission denied for table trader_series_weekly" \
  "authenticated" \
  "SELECT * FROM arena.trader_series_weekly;"
assert_equal \
  "service weekly parent read" \
  "1" \
  "$(psql_as authenticator -Atqc 'SET ROLE service_role; SELECT count(*) FROM arena.trader_series_weekly;')"
psql_as authenticator -q -c "SET ROLE service_role; INSERT INTO arena.trader_series_weekly(source, trader_key, observed_at, value) VALUES ('binance_futures', 'service-write', '2026-08-18T00:00:00.000Z', 1); UPDATE arena.trader_series_weekly SET value = 2 WHERE trader_key = 'service-write'; DELETE FROM arena.trader_series_weekly WHERE trader_key = 'service-write';"

forbidden_rpc_sql="SET ROLE anon; SELECT public.arena_roi_sparklines('{}'::jsonb, 90, 1);"
expect_failure_contains \
  "anonymous-canonical-sparkline-rpc" \
  "permission denied for function arena_roi_sparklines" \
  "$forbidden_rpc_sql"
expect_failure_contains \
  "anonymous-phantom-sparkline-overload" \
  "permission denied for function arena_roi_sparklines" \
  "SET ROLE anon; SELECT public.arena_roi_sparklines('{}'::jsonb, 90::bigint, 1);"
expect_failure_contains \
  "anonymous-canonical-core-rpc" \
  "permission denied for function arena_core_modules" \
  "SET ROLE anon; SELECT public.arena_core_modules('binance_futures', 'seed', 90);"
expect_failure_contains \
  "anonymous-phantom-core-overload" \
  "permission denied for function arena_core_modules" \
  "SET ROLE anon; SELECT public.arena_core_modules('binance_futures', 'seed', 90::bigint);"
expect_failure_contains \
  "anonymous-backtest-snapshot-rpc" \
  "permission denied for function snapshot_score_backtest" \
  "SET ROLE anon; SELECT public.snapshot_score_backtest();"
expect_failure_contains \
  "anonymous-phantom-backtest-snapshot-overload" \
  "permission denied for function snapshot_score_backtest" \
  "SET ROLE anon; SELECT public.snapshot_score_backtest(90);"
expect_failure_contains \
  "anonymous-backtest-evaluate-rpc" \
  "permission denied for function evaluate_score_backtest" \
  "SET ROLE anon; SELECT public.evaluate_score_backtest(90);"
expect_failure_contains \
  "anonymous-phantom-backtest-evaluate-overload" \
  "permission denied for function evaluate_score_backtest" \
  "SET ROLE anon; SELECT public.evaluate_score_backtest(90::bigint);"

psql_as authenticator -q -c "SET ROLE service_role; SELECT public.arena_core_modules('binance_futures', 'seed', 90); SELECT public.snapshot_score_backtest(); SELECT public.evaluate_score_backtest(90);"
expect_failure_as_contains \
  "service-retired-sparkline-rpc" \
  "permission denied for function arena_roi_sparklines" \
  "authenticator" \
  "SET ROLE service_role; SELECT public.arena_roi_sparklines('{}'::jsonb, 90, 1);"

# The real production partition helper creates a future monthly child after the
# cutover. Parent service CRUD remains valid, while the child is not a direct
# service or browser API surface. Deliberately hostile postgres default ACLs
# prove the real helper clears privileges that would otherwise attach to a new
# child at CREATE TABLE time.
psql_cmd -q <<'SQL'
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena
  GRANT SELECT ON TABLES TO PUBLIC, anon, authenticated, service_role;
SQL
psql_cmd -q -c "SELECT arena.ensure_month_partitions('trader_series', 1, 0);"
FUTURE_CHILD="$(psql_cmd -Atqc "SELECT child.relname FROM pg_catalog.pg_inherits inheritance JOIN pg_catalog.pg_class child ON child.oid = inheritance.inhrelid WHERE inheritance.inhparent = 'arena.trader_series'::regclass AND child.relname <> 'trader_series_y2026m08' ORDER BY child.relname DESC LIMIT 1;")"
if [[ -z "$FUTURE_CHILD" ]]; then
  echo "[trader-series-publication-isolation] future monthly child was not created" >&2
  exit 1
fi
expect_failure_as_contains \
  "service-direct-future-monthly-child" \
  "permission denied for table $FUTURE_CHILD" \
  "authenticator" \
  "SET ROLE service_role; SELECT * FROM arena.$FUTURE_CHILD;"
expect_failure_as_contains \
  "authenticated-direct-future-monthly-child" \
  "permission denied for table $FUTURE_CHILD" \
  "authenticated" \
  "SELECT * FROM arena.$FUTURE_CHILD;"
assert_equal \
  "future monthly child retains no direct non-owner ACL after hostile defaults" \
  "0" \
  "$(psql_cmd -Atqc "SELECT count(*) FROM pg_catalog.pg_class relation CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))) privilege WHERE relation.oid = ('arena.$FUTURE_CHILD')::regclass AND privilege.grantee <> relation.relowner;")"
assert_equal \
  "future monthly child retains no direct policy after hostile defaults" \
  "0" \
  "$(psql_cmd -Atqc "SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid = ('arena.$FUTURE_CHILD')::regclass;")"
psql_cmd -q <<'SQL'
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena
  REVOKE SELECT ON TABLES FROM PUBLIC, anon, authenticated, service_role;
SQL
assert_equal \
  "service parent remains queryable after future child" \
  "1" \
  "$(psql_as authenticator -Atqc 'SET ROLE service_role; SELECT count(*) FROM arena.trader_series;')"

# An inherited service-role reader can directly reach raw data before a
# replay; the migration must reject the role graph rather than pretend its
# ACL/RLS rewrite remains browser-safe.
psql_cmd -q -c "GRANT service_role TO inherited_reader WITH INHERIT TRUE, SET FALSE"
assert_equal \
  "inherited service-role reader reaches raw data before rejection" \
  "1" \
  "$(psql_as inherited_reader -Atqc 'SELECT count(*) FROM arena.trader_series;')"
expect_migration_failure \
  "inherited-service-role-reader" \
  "trader-series service authority graph is unsafe"
psql_cmd -q -c "REVOKE service_role FROM inherited_reader"

# A multi-hop SET ROLE reader reaches the trusted gateway without inheriting it.
psql_cmd -q <<'SQL'
GRANT authenticator TO setter_bridge WITH INHERIT FALSE, SET TRUE;
GRANT setter_bridge TO setter_reader WITH INHERIT FALSE, SET TRUE;
SQL
assert_equal \
  "multi-hop SET ROLE reader reaches raw data before rejection" \
  "1" \
  "$(psql_as setter_reader -Atqc 'SET ROLE setter_bridge; SET ROLE authenticator; SET ROLE service_role; SELECT count(*) FROM arena.trader_series;')"
expect_migration_failure \
  "multi-hop-set-role-reader" \
  "trader-series service authority graph is unsafe"
psql_cmd -q <<'SQL'
REVOKE setter_bridge FROM setter_reader;
REVOKE authenticator FROM setter_bridge;
SQL

# ADMIN-only bridge is authority too: it can delegate the canonical gateway to
# a fresh login which can then SET authenticator -> service_role.
psql_cmd -q -c "GRANT authenticator TO admin_bridge WITH ADMIN TRUE, INHERIT FALSE, SET FALSE"
expect_migration_failure \
  "ADMIN-only bridge" \
  "trader-series service authority graph is unsafe"
psql_as admin_bridge -q -c "GRANT authenticator TO delegated_reader WITH INHERIT FALSE, SET TRUE"
assert_equal \
  "ADMIN-only bridge delegates raw role path" \
  "1" \
  "$(psql_as delegated_reader -Atqc 'SET ROLE authenticator; SET ROLE service_role; SELECT count(*) FROM arena.trader_series;')"
expect_migration_failure \
  "delegated-reader-after-ADMIN-only-bridge" \
  "trader-series service authority graph is unsafe"
psql_as admin_bridge -q -c "REVOKE authenticator FROM delegated_reader"
psql_cmd -q -c "REVOKE authenticator FROM admin_bridge"

# Replay after every hostile edge is removed must converge to the same secure
# boundary and leave all browser roles unable to read raw parent/child tables.
psql_cmd -q -f "$MIGRATION"
expect_failure_as_contains \
  "inherited-reader-denied-after-replay" \
  "permission denied for table trader_series" \
  "inherited_reader" \
  "SELECT * FROM arena.trader_series;"
expect_failure_as_contains \
  "setter-reader-denied-after-replay" \
  "permission denied for table trader_series" \
  "setter_reader" \
  "SELECT * FROM arena.trader_series;"
expect_failure_as_contains \
  "delegated-reader-denied-after-replay" \
  "permission denied for table trader_series" \
  "delegated_reader" \
  "SELECT * FROM arena.trader_series;"

psql_cmd -q <<'SQL'
DO $assertions$
DECLARE
  v_relation oid;
  v_expected_policy name;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'arena.trader_series'::regclass::oid,
    'arena.trader_series_y2026m08'::regclass::oid,
    'arena.trader_series_weekly'::regclass::oid
  ]::oid[]
  LOOP
    IF NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_class
         WHERE oid = v_relation AND relowner = 'postgres'::regrole AND relrowsecurity
       ) THEN
      RAISE EXCEPTION 'trader-series relation ownership/RLS did not converge';
    END IF;
  END LOOP;

  FOR v_relation, v_expected_policy IN
    SELECT 'arena.trader_series'::regclass::oid, 'trader_series_service_role_only'::name
    UNION ALL
    SELECT 'arena.trader_series_weekly'::regclass::oid, 'trader_series_weekly_service_role_only'::name
  LOOP
    IF (
         SELECT count(*)
         FROM pg_catalog.pg_policy AS policy
         WHERE policy.polrelid = v_relation
       ) <> 1 OR NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_policy AS policy
         WHERE policy.polrelid = v_relation
           AND policy.polname = v_expected_policy
           AND policy.polcmd = '*'
           AND policy.polroles = ARRAY['service_role'::regrole]::oid[]
           AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
           AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
       ) THEN
      RAISE EXCEPTION 'trader-series parent policy did not converge';
    END IF;

    IF EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS relation
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
         ) AS privilege
         WHERE relation.oid = v_relation
           AND privilege.grantee <> relation.relowner
           AND (
             privilege.grantee <> 'service_role'::regrole
             OR privilege.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
             OR privilege.is_grantable
           )
       ) THEN
      RAISE EXCEPTION 'trader-series parent retained raw table ACL';
    END IF;
  END LOOP;

  FOREACH v_relation IN ARRAY ARRAY[
    'arena.trader_series_y2026m08'::regclass::oid
  ]::oid[]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = v_relation)
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS relation
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
         ) AS privilege
         WHERE relation.oid = v_relation
           AND privilege.grantee <> relation.relowner
       ) THEN
      RAISE EXCEPTION 'trader-series child retained direct raw policy or ACL';
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege('anon', 'public.arena_core_modules(text,text,integer)'::regprocedure, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.arena_core_modules(text,text,integer)'::regprocedure, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.arena_roi_sparklines(jsonb,integer,integer)'::regprocedure, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.arena_roi_sparklines(jsonb,integer,integer)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'raw-series function ACL did not converge';
  END IF;

  -- Enumerate every public overload, including intentionally created phantom
  -- snapshot/evaluate signatures. No browser role may execute any one; only
  -- the three explicit internal canonical signatures retain service EXECUTE.
  IF EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = procedure.pronamespace
       WHERE namespace_row.nspname = 'public'
         AND procedure.prokind = 'f'
         AND procedure.proname IN (
           'arena_roi_sparklines',
           'arena_core_modules',
           'snapshot_score_backtest',
           'evaluate_score_backtest'
         )
         AND (
           pg_catalog.has_function_privilege('anon', procedure.oid, 'EXECUTE')
           OR pg_catalog.has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
           OR (
             procedure.oid = ANY (ARRAY[
               'public.arena_roi_sparklines(jsonb,integer,integer)'::regprocedure::oid,
               'public.arena_core_modules(text,text,integer)'::regprocedure::oid,
               'public.snapshot_score_backtest()'::regprocedure::oid,
               'public.evaluate_score_backtest(integer)'::regprocedure::oid
             ]::oid[])
             AND procedure.oid <> 'public.arena_roi_sparklines(jsonb,integer,integer)'::regprocedure::oid
             AND NOT pg_catalog.has_function_privilege('service_role', procedure.oid, 'EXECUTE')
           )
           OR (
             procedure.oid <> ALL (ARRAY[
               'public.arena_core_modules(text,text,integer)'::regprocedure::oid,
               'public.snapshot_score_backtest()'::regprocedure::oid,
               'public.evaluate_score_backtest(integer)'::regprocedure::oid
             ]::oid[])
             AND pg_catalog.has_function_privilege('service_role', procedure.oid, 'EXECUTE')
           )
         )
     ) THEN
    RAISE EXCEPTION 'trader-series overload ACL did not converge';
  END IF;
END
$assertions$;
SQL

echo "[trader-series-publication-isolation] PostgreSQL 17 proof passed"
