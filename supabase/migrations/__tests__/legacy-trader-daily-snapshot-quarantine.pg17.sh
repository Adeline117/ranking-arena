#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the legacy daily-snapshot quarantine.
# It creates and destroys its own cluster and never connects to an app DB.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260808090000_quarantine_legacy_trader_daily_snapshots.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/daily-snapshot-quarantine-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 2000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -160 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" \
    -X \
    -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" \
    -p "$PORT" \
    -U postgres \
    -d postgres \
    "$@"
}

psql_db() {
  local database_name="$1"
  shift
  "$PG_BIN/psql" \
    -X \
    -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" \
    -p "$PORT" \
    -U postgres \
    -d "$database_name" \
    "$@"
}

expect_failure() {
  local name="$1"
  local sql="$2"
  if psql_cmd -c "$sql" >"$TMP_ROOT/$name.log" 2>&1; then
    echo "expected failure succeeded: $name" >&2
    exit 1
  fi
}

expect_migration_failure() {
  local name="$1"
  if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/$name.log" 2>&1; then
    echo "quarantine migration unexpectedly succeeded: $name" >&2
    exit 1
  fi
}

expect_migration_failure_in_db() {
  local name="$1"
  local database_name="$2"
  if psql_db "$database_name" -f "$MIGRATION" >"$TMP_ROOT/$name.log" 2>&1; then
    echo "quarantine migration unexpectedly succeeded in $database_name: $name" >&2
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

psql_cmd -q <<'SQL'
CREATE ROLE operator_maintenance NOLOGIN;
CREATE ROLE backup_reader NOLOGIN;
CREATE ROLE inherited_column_writer NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
-- Match Supabase: BYPASSRLS must not turn service_role's SELECT grant into DML.
CREATE ROLE service_role NOLOGIN BYPASSRLS;

-- Seed an inherited operator path. The migration must fail and roll back,
-- never revoke the operator role as an unrequested side effect.
GRANT operator_maintenance TO service_role;

CREATE TABLE public.trader_daily_snapshots (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  platform text NOT NULL,
  trader_key text NOT NULL,
  date date NOT NULL,
  roi numeric,
  pnl numeric,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (platform, trader_key, date)
);

ALTER TABLE public.trader_daily_snapshots ENABLE ROW LEVEL SECURITY;

GRANT ALL PRIVILEGES ON TABLE public.trader_daily_snapshots
  TO PUBLIC, anon, authenticated, service_role, operator_maintenance;
GRANT SELECT ON TABLE public.trader_daily_snapshots TO backup_reader;
GRANT SELECT (id, platform, trader_key, date, roi, pnl),
  INSERT (platform, trader_key, date, roi, pnl),
  UPDATE (roi, pnl),
  REFERENCES (id)
  ON TABLE public.trader_daily_snapshots
  TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT (id, platform, trader_key, date)
  ON TABLE public.trader_daily_snapshots
  TO backup_reader;

CREATE POLICY "trader_daily_snapshots_select_all"
  ON public.trader_daily_snapshots
  FOR SELECT
  TO public
  USING (true);
CREATE POLICY "trader_daily_snapshots_service_role_write"
  ON public.trader_daily_snapshots
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "Unreviewed operator policy"
  ON public.trader_daily_snapshots
  FOR SELECT
  TO backup_reader
  USING (true);

INSERT INTO public.trader_daily_snapshots (
  id,
  platform,
  trader_key,
  date,
  roi,
  pnl,
  created_at
) VALUES
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'binance',
    'alpha',
    DATE '2026-08-06',
    12.3456,
    9007199254740993.0001,
    TIMESTAMPTZ '2026-08-07 00:00:00+00'
  ),
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
    'bybit',
    'beta',
    DATE '2026-08-07',
    -3.25,
    -101.75,
    TIMESTAMPTZ '2026-08-08 00:00:00+00'
  );

CREATE TABLE public.daily_snapshot_quarantine_fixture_proof (
  relation_oid oid NOT NULL,
  row_payload jsonb NOT NULL
);
INSERT INTO public.daily_snapshot_quarantine_fixture_proof(
  relation_oid,
  row_payload
)
SELECT
  'public.trader_daily_snapshots'::regclass::oid,
  pg_catalog.jsonb_agg(
    pg_catalog.to_jsonb(snapshot_row)
    ORDER BY snapshot_row.id
  )
FROM public.trader_daily_snapshots AS snapshot_row;

CREATE FUNCTION public.cleanup_all_data_violations(
  batch_limit integer DEFAULT 25
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_count bigint;
BEGIN
  UPDATE public.trader_daily_snapshots SET roi = NULL
  WHERE id IN (
    SELECT id FROM public.trader_daily_snapshots LIMIT batch_limit
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$function$;

-- A drifted overload proves the migration resolves identity arguments from
-- pg_proc instead of assuming the generated TypeScript signature is complete.
CREATE FUNCTION public.cleanup_all_data_violations(mode text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_count bigint;
BEGIN
  UPDATE public.trader_daily_snapshots SET pnl = NULL
  WHERE mode = 'all';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$function$;

CREATE FUNCTION public.cleanup_snapshot_violations(
  batch_limit integer DEFAULT 25
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RETURN batch_limit;
END
$function$;

CREATE FUNCTION public.cleanup_stale_data()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.trader_daily_snapshots
  WHERE date < DATE '2099-01-01';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$function$;

CREATE FUNCTION public.get_latest_prev_snapshots(
  target_platforms text[],
  before_date text
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT pg_catalog.count(*)
  FROM public.trader_daily_snapshots
  WHERE platform = ANY (target_platforms)
    AND date < before_date::date
$function$;

CREATE FUNCTION public.get_latest_snapshots_for_date(target_date text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT pg_catalog.count(*)
  FROM public.trader_daily_snapshots
  WHERE date = target_date::date
$function$;

CREATE FUNCTION public.exec_sql(sql text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  EXECUTE sql;
END
$function$;

CREATE FUNCTION public.unrelated_operator_helper()
RETURNS integer
LANGUAGE sql
AS 'SELECT 7';

GRANT EXECUTE ON FUNCTION
  public.cleanup_all_data_violations(integer),
  public.cleanup_all_data_violations(text),
  public.cleanup_snapshot_violations(integer),
  public.cleanup_stale_data(),
  public.get_latest_prev_snapshots(text[], text),
  public.get_latest_snapshots_for_date(text),
  public.exec_sql(text)
TO operator_maintenance;
SQL

# The historical table is an ordinary standalone table. A same-named
# partition child would remain reachable and writable through its parent, so
# schema drift must fail before any ACL mutation.
psql_cmd -q -c 'CREATE DATABASE daily_snapshot_partition_drift'
psql_db daily_snapshot_partition_drift -q <<'SQL'
CREATE TABLE public.all_daily_snapshots (
  id uuid NOT NULL,
  platform text NOT NULL,
  trader_key text NOT NULL,
  date date NOT NULL,
  roi numeric
) PARTITION BY LIST (platform);

CREATE TABLE public.trader_daily_snapshots
  PARTITION OF public.all_daily_snapshots
  FOR VALUES IN ('binance');

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.all_daily_snapshots
  TO anon;
SQL

expect_migration_failure_in_db partition_child_drift daily_snapshot_partition_drift
if ! grep -q \
  'public.trader_daily_snapshots must not be a partition child' \
  "$TMP_ROOT/partition_child_drift.log"; then
  cat "$TMP_ROOT/partition_child_drift.log" >&2
  exit 1
fi

psql_db daily_snapshot_partition_drift -q <<'SQL'
SET ROLE anon;
INSERT INTO public.all_daily_snapshots(id, platform, trader_key, date, roi)
VALUES (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'binance',
  'partition-proof',
  DATE '2026-08-08',
  11
);
UPDATE public.all_daily_snapshots SET roi = 12
WHERE trader_key = 'partition-proof';
SELECT id FROM public.all_daily_snapshots
WHERE trader_key = 'partition-proof';
RESET ROLE;
SQL
psql_cmd -q -c 'DROP DATABASE daily_snapshot_partition_drift'

# Unknown policies require explicit review and must fail before mutating ACLs.
expect_migration_failure unknown_policy
if ! grep -q \
  'unknown trader_daily_snapshots policies require operator review' \
  "$TMP_ROOT/unknown_policy.log"; then
  cat "$TMP_ROOT/unknown_policy.log" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $unknown_policy_rollback$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.trader_daily_snapshots'::regclass
      AND policy.polname = 'Unreviewed operator policy'
  ) OR NOT pg_catalog.has_table_privilege(
    'anon',
    'public.trader_daily_snapshots',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'unknown-policy preflight did not roll back cleanly';
  END IF;
END
$unknown_policy_rollback$;

DROP POLICY "Unreviewed operator policy"
  ON public.trader_daily_snapshots;
SQL

# service_role still inherits operator_maintenance's ALL/EXECUTE. Explicitly
# revoking third-party grants is outside migration scope, so postflight fails.
expect_migration_failure inherited_operator_path
if ! grep -Eq \
  'service_role still has (INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)' \
  "$TMP_ROOT/inherited_operator_path.log"; then
  cat "$TMP_ROOT/inherited_operator_path.log" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $inherited_path_rollback$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.trader_daily_snapshots'::regclass
      AND policy.polname = 'trader_daily_snapshots_select_all'
  ) OR NOT pg_catalog.has_table_privilege(
    'authenticated',
    'public.trader_daily_snapshots',
    'UPDATE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.exec_sql(text)'::regprocedure,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'inherited-path postflight did not roll back cleanly';
  END IF;
END
$inherited_path_rollback$;

REVOKE operator_maintenance FROM service_role;
SQL

# Column-only grants inherited through another role do not appear in
# has_table_privilege. The migration must detect the effective column write
# and delegable SELECT paths, then roll back without revoking the third-party
# grant or membership.
psql_cmd -q <<'SQL'
GRANT INSERT (platform, trader_key, date, roi),
  UPDATE (roi),
  REFERENCES (id)
  ON TABLE public.trader_daily_snapshots
  TO inherited_column_writer;
GRANT SELECT (id)
  ON TABLE public.trader_daily_snapshots
  TO inherited_column_writer
  WITH GRANT OPTION;
GRANT inherited_column_writer TO service_role;
SQL

expect_migration_failure inherited_column_path
if ! grep -Eq \
  'service_role still has column (INSERT|UPDATE|REFERENCES|SELECT WITH GRANT OPTION)' \
  "$TMP_ROOT/inherited_column_path.log"; then
  cat "$TMP_ROOT/inherited_column_path.log" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $inherited_column_rollback$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.trader_daily_snapshots'::regclass
      AND policy.polname = 'trader_daily_snapshots_select_all'
  ) OR NOT pg_catalog.has_column_privilege(
    'service_role',
    'public.trader_daily_snapshots',
    'roi',
    'UPDATE'
  ) OR NOT pg_catalog.has_column_privilege(
    'service_role',
    'public.trader_daily_snapshots',
    'id',
    'SELECT WITH GRANT OPTION'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.exec_sql(text)'::regprocedure,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'inherited-column postflight did not roll back cleanly';
  END IF;
END
$inherited_column_rollback$;

REVOKE inherited_column_writer FROM service_role;
SQL

# A nested owner-security view can expose the base table without any grant on
# the base table or the intermediate view. The migration must recurse through
# pg_rewrite dependencies and fail before changing the base ACL or policies.
psql_cmd -q <<'SQL'
CREATE VIEW public.daily_snapshot_operator_view AS
SELECT id, platform, trader_key, date, roi, pnl
FROM public.trader_daily_snapshots;

CREATE VIEW public.daily_snapshot_app_view AS
SELECT id, platform, trader_key, date, roi, pnl
FROM public.daily_snapshot_operator_view;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.daily_snapshot_app_view
  TO anon;
SQL

expect_migration_failure dependent_view_path
if ! grep -Eq \
  'anon retains (SELECT|INSERT|UPDATE|DELETE) on dependent daily snapshot relation public.daily_snapshot_app_view' \
  "$TMP_ROOT/dependent_view_path.log"; then
  cat "$TMP_ROOT/dependent_view_path.log" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $dependent_view_rollback$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.trader_daily_snapshots'::regclass
      AND policy.polname = 'trader_daily_snapshots_select_all'
  ) OR NOT pg_catalog.has_table_privilege(
    'anon',
    'public.daily_snapshot_app_view',
    'SELECT, INSERT, UPDATE, DELETE'
  ) OR NOT pg_catalog.has_table_privilege(
    'authenticated',
    'public.trader_daily_snapshots',
    'UPDATE'
  ) THEN
    RAISE EXCEPTION 'dependent-view preflight did not preserve live state';
  END IF;
END
$dependent_view_rollback$;

DROP VIEW public.daily_snapshot_app_view;
DROP VIEW public.daily_snapshot_operator_view;
SQL

# A non-view rewrite rule runs with the rule owner's authority and can mutate
# the base table from an app-writable inbox.
psql_cmd -q <<'SQL'
CREATE TABLE public.daily_snapshot_rule_inbox (
  platform text NOT NULL,
  trader_key text NOT NULL,
  date date NOT NULL,
  roi numeric
);

CREATE RULE daily_snapshot_rule_writer AS
ON INSERT TO public.daily_snapshot_rule_inbox
DO ALSO
  INSERT INTO public.trader_daily_snapshots(
    platform,
    trader_key,
    date,
    roi
  ) VALUES (
    NEW.platform,
    NEW.trader_key,
    NEW.date,
    NEW.roi
  );

GRANT INSERT ON TABLE public.daily_snapshot_rule_inbox TO anon;
SQL

expect_migration_failure rewrite_rule_path
if ! grep -q \
  'non-view rewrite rule daily_snapshot_rule_writer' \
  "$TMP_ROOT/rewrite_rule_path.log"; then
  cat "$TMP_ROOT/rewrite_rule_path.log" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $rewrite_rule_rollback$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.trader_daily_snapshots'::regclass
      AND policy.polname = 'trader_daily_snapshots_select_all'
  ) OR NOT pg_catalog.has_table_privilege(
    'anon',
    'public.daily_snapshot_rule_inbox',
    'INSERT'
  ) THEN
    RAISE EXCEPTION 'rewrite-rule preflight did not preserve live state';
  END IF;
END
$rewrite_rule_rollback$;

BEGIN;
SET LOCAL ROLE anon;
INSERT INTO public.daily_snapshot_rule_inbox(platform, trader_key, date, roi)
VALUES ('okx', 'rule-proof', DATE '2026-08-08', 9);
ROLLBACK;

DROP TABLE public.daily_snapshot_rule_inbox;
SQL

# A parent-table referential action bypasses child ACL/RLS. The reviewed daily
# table has no outgoing FK, so any live FK blocks quarantine for drift review.
psql_cmd -q <<'SQL'
CREATE TABLE public.daily_snapshot_parent (
  id bigint PRIMARY KEY
);
ALTER TABLE public.trader_daily_snapshots
  ADD COLUMN parent_id bigint;
ALTER TABLE public.trader_daily_snapshots
  ADD CONSTRAINT trader_daily_snapshots_parent_fk
  FOREIGN KEY (parent_id)
  REFERENCES public.daily_snapshot_parent(id)
  ON UPDATE CASCADE
  ON DELETE CASCADE;
GRANT SELECT, UPDATE, DELETE
  ON TABLE public.daily_snapshot_parent
  TO anon;
SQL

expect_migration_failure foreign_key_path
if ! grep -q \
  'unreviewed daily snapshot foreign key trader_daily_snapshots_parent_fk' \
  "$TMP_ROOT/foreign_key_path.log"; then
  cat "$TMP_ROOT/foreign_key_path.log" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $foreign_key_rollback$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.trader_daily_snapshots'::regclass
      AND constraint_row.conname =
        'trader_daily_snapshots_parent_fk'
  ) OR NOT pg_catalog.has_table_privilege(
    'anon',
    'public.daily_snapshot_parent',
    'UPDATE, DELETE'
  ) THEN
    RAISE EXCEPTION 'foreign-key preflight did not preserve live state';
  END IF;
END
$foreign_key_rollback$;

BEGIN;
INSERT INTO public.daily_snapshot_parent(id) VALUES (1);
INSERT INTO public.trader_daily_snapshots(
  platform,
  trader_key,
  date,
  roi,
  parent_id
) VALUES ('okx', 'fk-proof', DATE '2026-08-08', 9, 1);
SET LOCAL ROLE anon;
DELETE FROM public.daily_snapshot_parent WHERE id = 1;
RESET ROLE;
DO $cascade_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.trader_daily_snapshots
    WHERE trader_key = 'fk-proof'
  ) THEN
    RAISE EXCEPTION 'foreign-key cascade proof did not delete child row';
  END IF;
END
$cascade_proof$;
ROLLBACK;

ALTER TABLE public.trader_daily_snapshots
  DROP CONSTRAINT trader_daily_snapshots_parent_fk,
  DROP COLUMN parent_id;
DROP TABLE public.daily_snapshot_parent;
SQL

# Trigger functions run through the trigger owner path and do not require the
# invoking role to hold EXECUTE. An app-writable inbox with a SECURITY DEFINER
# trigger that writes daily snapshots must block the migration before mutation.
psql_cmd -q <<'SQL'
CREATE TABLE public.daily_snapshot_inbox (
  platform text NOT NULL,
  trader_key text NOT NULL,
  date date NOT NULL,
  roi numeric
);

CREATE FUNCTION public.daily_snapshot_trigger_writer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  INSERT INTO public.trader_daily_snapshots(
    platform,
    trader_key,
    date,
    roi
  ) VALUES (
    NEW.platform,
    NEW.trader_key,
    NEW.date,
    NEW.roi
  );
  RETURN NEW;
END
$function$;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.daily_snapshot_trigger_writer()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT ON TABLE public.daily_snapshot_inbox TO anon;

CREATE TRIGGER daily_snapshot_inbox_writer
AFTER INSERT ON public.daily_snapshot_inbox
FOR EACH ROW
EXECUTE FUNCTION public.daily_snapshot_trigger_writer();
SQL

expect_migration_failure security_definer_trigger_path
if ! grep -q \
  'anon can fire SECURITY DEFINER daily snapshot trigger daily_snapshot_inbox_writer' \
  "$TMP_ROOT/security_definer_trigger_path.log"; then
  cat "$TMP_ROOT/security_definer_trigger_path.log" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $trigger_path_rollback$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.trader_daily_snapshots'::regclass
      AND policy.polname = 'trader_daily_snapshots_select_all'
  ) OR NOT pg_catalog.has_table_privilege(
    'anon',
    'public.daily_snapshot_inbox',
    'INSERT'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.daily_snapshot_trigger_writer()'::regprocedure,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFINER trigger preflight did not preserve live state';
  END IF;
END
$trigger_path_rollback$;

BEGIN;
SET LOCAL ROLE anon;
INSERT INTO public.daily_snapshot_inbox(platform, trader_key, date, roi)
VALUES ('okx', 'trigger-proof', DATE '2026-08-08', 9);
ROLLBACK;

DROP TABLE public.daily_snapshot_inbox;
DROP FUNCTION public.daily_snapshot_trigger_writer();
SQL

# An unknown SECURITY DEFINER function that names the table is not mutated.
# Its default PUBLIC grant must make the migration fail and roll back.
psql_cmd -q <<'SQL'
CREATE FUNCTION public.out_of_band_daily_reader()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT pg_catalog.count(*) FROM public.trader_daily_snapshots
$function$;

GRANT EXECUTE
  ON FUNCTION public.out_of_band_daily_reader()
  TO operator_maintenance;
SQL

expect_migration_failure unreviewed_security_definer
if ! grep -q \
  'unreviewed SECURITY DEFINER daily snapshot routine' \
  "$TMP_ROOT/unreviewed_security_definer.log"; then
  cat "$TMP_ROOT/unreviewed_security_definer.log" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $definer_rollback$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.exec_sql(text)'::regprocedure,
    'EXECUTE'
  ) OR NOT pg_catalog.has_table_privilege(
    'anon',
    'public.trader_daily_snapshots',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFINER postflight did not roll back cleanly';
  END IF;
END
$definer_rollback$;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.out_of_band_daily_reader()
  FROM PUBLIC, anon, authenticated, service_role;
SQL

# Exposed schemas are deployment state. A callable SECURITY DEFINER routine in
# any non-system schema can bypass the base table even when public is sealed.
psql_cmd -q <<'SQL'
CREATE SCHEMA api;
GRANT USAGE ON SCHEMA api TO anon;

CREATE FUNCTION api.daily_snapshot_writer()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  INSERT INTO public.trader_daily_snapshots(
    platform,
    trader_key,
    date,
    roi
  ) VALUES (
    'okx',
    'cross-schema-proof',
    DATE '2026-08-08',
    9
  )
$function$;

GRANT EXECUTE ON FUNCTION api.daily_snapshot_writer() TO anon;
SQL

expect_migration_failure cross_schema_security_definer
if ! grep -q \
  'unreviewed SECURITY DEFINER daily snapshot routine api.daily_snapshot_writer() is callable by anon' \
  "$TMP_ROOT/cross_schema_security_definer.log"; then
  cat "$TMP_ROOT/cross_schema_security_definer.log" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $cross_schema_rollback$
BEGIN
  IF NOT pg_catalog.has_schema_privilege(
    'anon',
    'api',
    'USAGE'
  ) OR NOT pg_catalog.has_function_privilege(
    'anon',
    'api.daily_snapshot_writer()'::regprocedure,
    'EXECUTE'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.trader_daily_snapshots'::regclass
      AND policy.polname = 'trader_daily_snapshots_select_all'
  ) THEN
    RAISE EXCEPTION 'cross-schema routine preflight did not preserve live state';
  END IF;
END
$cross_schema_rollback$;

BEGIN;
SET LOCAL ROLE anon;
SELECT api.daily_snapshot_writer();
ROLLBACK;

DROP SCHEMA api CASCADE;
SQL

# The approved fixture now converges, and a second application proves replay.
psql_cmd -q -f "$MIGRATION"
psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
DO $catalog_contract$
DECLARE
  v_relation regclass := 'public.trader_daily_snapshots'::regclass;
  v_service_role_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
  v_role name;
  v_routine record;
BEGIN
  IF (
    SELECT proof.relation_oid <> v_relation::oid
        OR proof.row_payload <> current_rows.row_payload
    FROM public.daily_snapshot_quarantine_fixture_proof AS proof
    CROSS JOIN LATERAL (
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(snapshot_row)
        ORDER BY snapshot_row.id
      ) AS row_payload
      FROM public.trader_daily_snapshots AS snapshot_row
    ) AS current_rows
  ) THEN
    RAISE EXCEPTION 'quarantine replaced the table or modified preserved rows';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation
      AND policy.polname = 'Service role reads quarantined daily snapshots'
      AND policy.polpermissive
      AND policy.polcmd = 'r'
      AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND policy.polwithcheck IS NULL
  ) THEN
    RAISE EXCEPTION 'daily snapshot policy is not exact read-only service policy';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
    'service_role',
    v_relation,
    'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'service_role',
    v_relation,
    'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
  ) THEN
    RAISE EXCEPTION 'service_role table ACL is not SELECT-only';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
    'operator_maintenance',
    v_relation,
    'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
  ) OR NOT pg_catalog.has_table_privilege(
    'backup_reader',
    v_relation,
    'SELECT'
  ) OR NOT pg_catalog.has_column_privilege(
    'backup_reader',
    v_relation,
    'platform',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'migration mutated reviewed operator/backup ACLs';
  END IF;

  FOR v_routine IN
    SELECT routine.oid, routine.proname
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
      AND routine.prokind = 'f'
      AND routine.proname = ANY (
        ARRAY[
          'cleanup_all_data_violations',
          'cleanup_snapshot_violations',
          'cleanup_stale_data',
          'exec_sql',
          'get_latest_prev_snapshots',
          'get_latest_snapshots_for_date'
        ]::name[]
      )
  LOOP
    FOREACH v_role IN ARRAY ARRAY[
      'anon',
      'authenticated',
      'service_role'
    ]::name[]
    LOOP
      IF pg_catalog.has_function_privilege(
        v_role,
        v_routine.oid,
        'EXECUTE'
      ) THEN
        RAISE EXCEPTION
          '% retains EXECUTE on % (oid %)',
          v_role,
          v_routine.proname,
          v_routine.oid;
      END IF;
    END LOOP;

    IF NOT pg_catalog.has_function_privilege(
      'operator_maintenance',
      v_routine.oid,
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION
        'operator routine grant was removed from % (oid %)',
        v_routine.proname,
        v_routine.oid;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_function_privilege(
    'authenticated',
    'public.unrelated_operator_helper()'::regprocedure,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'unrelated function default EXECUTE was changed';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'anon',
    'authenticated',
    'service_role'
  ]::name[]
  LOOP
    IF pg_catalog.has_function_privilege(
      v_role,
      'public.out_of_band_daily_reader()'::regprocedure,
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION
        '% can execute the reviewed out-of-band daily reader',
        v_role;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_function_privilege(
    'operator_maintenance',
    'public.out_of_band_daily_reader()'::regprocedure,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'out-of-band operator grant was not preserved';
  END IF;
END
$catalog_contract$;

-- Prove the explicit policy works even if service_role loses BYPASSRLS.
ALTER ROLE service_role NOBYPASSRLS;
SET ROLE service_role;
SELECT id, platform, trader_key, date, roi, pnl
FROM public.trader_daily_snapshots
ORDER BY id;
RESET ROLE;

SET ROLE authenticated;
SELECT public.unrelated_operator_helper();
RESET ROLE;
SQL

for role in anon authenticated; do
  expect_failure "${role}_select" \
    "SET ROLE $role; SELECT * FROM public.trader_daily_snapshots"
done

expect_failure service_insert \
  "SET ROLE service_role; INSERT INTO public.trader_daily_snapshots(platform,trader_key,date) VALUES ('okx','forged','2026-08-08')"
expect_failure service_update \
  "SET ROLE service_role; UPDATE public.trader_daily_snapshots SET roi = 999"
expect_failure service_delete \
  "SET ROLE service_role; DELETE FROM public.trader_daily_snapshots"
expect_failure service_truncate \
  "SET ROLE service_role; TRUNCATE TABLE public.trader_daily_snapshots"

for role in anon authenticated service_role; do
  expect_failure "${role}_cleanup_all_integer" \
    "SET ROLE $role; SELECT public.cleanup_all_data_violations(25)"
  expect_failure "${role}_cleanup_all_text" \
    "SET ROLE $role; SELECT public.cleanup_all_data_violations('all'::text)"
  expect_failure "${role}_cleanup_snapshot" \
    "SET ROLE $role; SELECT public.cleanup_snapshot_violations(25)"
  expect_failure "${role}_cleanup_stale" \
    "SET ROLE $role; SELECT public.cleanup_stale_data()"
  expect_failure "${role}_latest_prev" \
    "SET ROLE $role; SELECT public.get_latest_prev_snapshots(ARRAY['binance']::text[], '2026-08-08')"
  expect_failure "${role}_latest_for_date" \
    "SET ROLE $role; SELECT public.get_latest_snapshots_for_date('2026-08-07')"
  expect_failure "${role}_exec_sql" \
    "SET ROLE $role; SELECT public.exec_sql('DELETE FROM public.trader_daily_snapshots')"
done

psql_cmd -q <<'SQL'
DO $final_rows$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.trader_daily_snapshots
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM public.trader_daily_snapshots
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
      AND roi = 12.3456
      AND pnl = 9007199254740993.0001
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.trader_daily_snapshots
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
      AND roi = -3.25
      AND pnl = -101.75
  ) THEN
    RAISE EXCEPTION 'failed-call proof modified preserved daily snapshot rows';
  END IF;
END
$final_rows$;
SQL

echo "legacy trader_daily_snapshots quarantine PG17 proof passed"
