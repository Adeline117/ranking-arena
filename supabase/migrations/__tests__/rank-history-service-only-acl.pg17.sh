#!/usr/bin/env bash

# PostgreSQL 17 disposable proof for the rank-history raw ACL cutover. It owns
# an isolated temporary cluster and never connects to application or remote DBs.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260817020000_rank_history_service_only_acl.sql"
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

TMP_ROOT="$(mktemp -d /tmp/rank-history-service-only-acl-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((60000 + ($$ % 4000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    echo "[rank-history-service-only-acl] PostgreSQL log tail:" >&2
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

psql_as() {
  local role="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U "$role" -d postgres "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "[rank-history-service-only-acl] $label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

expect_failure_contains() {
  local label="$1"
  local needle="$2"
  local sql="$3"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"

  if psql_cmd -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "[rank-history-service-only-acl] Expected failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[rank-history-service-only-acl] Unexpected failure for $label" >&2
    sed -n '1,180p' "$failure_log" >&2
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
    echo "[rank-history-service-only-acl] Expected failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[rank-history-service-only-acl] Unexpected failure for $label" >&2
    sed -n '1,180p' "$failure_log" >&2
    exit 1
  fi
}

expect_migration_failure() {
  local label="$1"
  local needle="$2"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"

  if psql_cmd -v VERBOSITY=verbose -f "$MIGRATION" >"$failure_log" 2>&1; then
    echo "[rank-history-service-only-acl] Expected migration failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[rank-history-service-only-acl] Unexpected migration failure for $label" >&2
    sed -n '1,220p' "$failure_log" >&2
    exit 1
  fi
}

v1_catalog_digest() {
  psql_cmd -Atq <<'SQL'
WITH identities AS (
  SELECT
    'relation:' || relation.oid::text || ':' || relation.relkind::text || ':' ||
      relation.relowner::text || ':' || relation.relrowsecurity::text || ':' ||
      relation.relforcerowsecurity::text || ':' || relation.relpersistence::text || ':' ||
      relation.relnatts::text AS identity
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'public.rank_history'::pg_catalog.regclass

  UNION ALL

  SELECT
    'attribute:' || attribute.attnum::text || ':' || attribute.attname || ':' ||
      attribute.atttypid::pg_catalog.regtype::text || ':' || attribute.atttypmod::text || ':' ||
      attribute.attnotnull::text || ':' || attribute.attidentity::text || ':' ||
      attribute.attgenerated::text || ':' || attribute.attisdropped::text || ':' ||
      COALESCE(
        pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid),
        '<null>'
      ) AS identity
  FROM pg_catalog.pg_attribute AS attribute
  LEFT JOIN pg_catalog.pg_attrdef AS default_row
    ON default_row.adrelid = attribute.attrelid
   AND default_row.adnum = attribute.attnum
  WHERE attribute.attrelid = 'public.rank_history'::pg_catalog.regclass
    AND attribute.attnum > 0

  UNION ALL

  SELECT
    'constraint:' || constraint_row.conname || ':' || constraint_row.contype::text || ':' ||
      constraint_row.condeferrable::text || ':' || constraint_row.condeferred::text || ':' ||
      pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS identity
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'public.rank_history'::pg_catalog.regclass

  UNION ALL

  SELECT
    'index:' || index_class.relname || ':' || index_row.indisprimary::text || ':' ||
      index_row.indisunique::text || ':' || pg_catalog.pg_get_indexdef(index_row.indexrelid) AS identity
  FROM pg_catalog.pg_index AS index_row
  JOIN pg_catalog.pg_class AS index_class
    ON index_class.oid = index_row.indexrelid
  WHERE index_row.indrelid = 'public.rank_history'::pg_catalog.regclass
)
SELECT pg_catalog.encode(
  pg_catalog.sha256(
    pg_catalog.convert_to(
      pg_catalog.string_agg(identity, '|' ORDER BY identity),
      'UTF8'
    )
  ),
  'hex'
)
FROM identities;
SQL
}

v1_row_digest() {
  psql_cmd -Atq <<'SQL'
SELECT pg_catalog.encode(
  pg_catalog.sha256(
    pg_catalog.convert_to(
      COALESCE(
        pg_catalog.string_agg(
          rank_history.id::text || ':' ||
            rank_history.platform || ':' ||
            rank_history.trader_key || ':' ||
            rank_history.period || ':' ||
            rank_history.rank::text || ':' ||
            COALESCE(rank_history.arena_score::text, '<null>') || ':' ||
            rank_history.snapshot_date::text || ':' ||
            COALESCE(rank_history.created_at::text, '<null>'),
          '|' ORDER BY
            rank_history.platform,
            rank_history.trader_key,
            rank_history.period,
            rank_history.snapshot_date,
            rank_history.id
        ),
        ''
      ),
      'UTF8'
    )
  ),
  'hex'
)
FROM public.rank_history AS rank_history;
SQL
}

boundary_digest() {
  psql_cmd -Atq <<'SQL'
WITH identities AS (
  SELECT
    'relation:' || relation.relrowsecurity::text || ':' ||
      relation.relforcerowsecurity::text || ':' ||
      COALESCE(relation.relacl::text, '<null>') AS identity
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'public.rank_history'::pg_catalog.regclass

  UNION ALL

  SELECT
    'policy:' || policy.polname || ':' || policy.polpermissive::text || ':' ||
      policy.polcmd::text || ':' || policy.polroles::text || ':' ||
      COALESCE(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), '<null>') || ':' ||
      COALESCE(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), '<null>') AS identity
  FROM pg_catalog.pg_policy AS policy
  WHERE policy.polrelid = 'public.rank_history'::pg_catalog.regclass

  UNION ALL

  SELECT
    'column:' || attribute.attnum::text || ':' ||
      COALESCE(attribute.attacl::text, '<null>') AS identity
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.rank_history'::pg_catalog.regclass
    AND attribute.attnum > 0
)
SELECT pg_catalog.encode(
  pg_catalog.sha256(
    pg_catalog.convert_to(
      pg_catalog.string_agg(identity, '|' ORDER BY identity),
      'UTF8'
    )
  ),
  'hex'
)
FROM identities;
SQL
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth=trust --username=postgres --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -k $SOCKET_DIR -p $PORT -c listen_addresses=''" -w start >/dev/null

echo "[rank-history-service-only-acl] build historical browser-readable fixture"
psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE inherited_reader LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE setter_reader LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE setter_bridge NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE admin_bridge LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE delegated_reader LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE table_delegator NOLOGIN NOBYPASSRLS;
CREATE ROLE delegated_table_reader NOLOGIN NOBYPASSRLS;
CREATE ROLE delegated_column_reader NOLOGIN NOBYPASSRLS;

GRANT USAGE ON SCHEMA public
  TO anon, authenticated, service_role, authenticator, inherited_reader,
     setter_reader, setter_bridge, admin_bridge, delegated_reader, table_delegator,
     delegated_table_reader, delegated_column_reader;

-- PostgREST connects as this NOINHERIT gateway and only SETs service_role
-- after it has validated a service JWT. The migration must preserve this exact
-- path while rejecting any reader that reaches it through another role.
GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE;

-- The v1 rank_history table shape: raw daily snapshots, a primary key, and
-- the unique key used by snapshot-ranks ON CONFLICT upserts.
CREATE TABLE public.rank_history (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  platform text NOT NULL,
  trader_key text NOT NULL,
  period text NOT NULL,
  rank integer NOT NULL,
  arena_score decimal(8, 2),
  snapshot_date date NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(platform, trader_key, period, snapshot_date)
);

ALTER TABLE public.rank_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY rank_history_select ON public.rank_history
  FOR SELECT USING (true);
CREATE POLICY rank_history_service_write ON public.rank_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Historical browser-readable fixture: public/default DML ACLs, a delegated
-- table reader, and a delegated-column-reader must all be collapsed by the
-- new migration.
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.rank_history TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.rank_history TO anon, authenticated, service_role;
GRANT SELECT ON TABLE public.rank_history TO table_delegator WITH GRANT OPTION;
SET ROLE table_delegator;
GRANT SELECT ON TABLE public.rank_history TO delegated_table_reader;
RESET ROLE;
GRANT SELECT (rank, arena_score), UPDATE (rank)
  ON TABLE public.rank_history TO delegated_column_reader;

INSERT INTO public.rank_history(
  platform, trader_key, period, rank, arena_score, snapshot_date
) VALUES
  ('binance_futures', 'seed', '90D', 7, 88.25, DATE '2026-08-16'),
  ('binance_futures', 'stale', '90D', 12, 77.00, DATE '2025-01-01');
SQL

V1_CATALOG_BEFORE="$(v1_catalog_digest)"
V1_ROWS_BEFORE="$(v1_row_digest)"

# Before the cutover the historical PUBLIC policy plus ACL exposes the raw row.
PRE_CUTOVER_COUNT="$(psql_cmd -Atqc "SET ROLE anon; SELECT count(*) FROM public.rank_history;")"
assert_equal "historical anonymous raw read" "2" "$PRE_CUTOVER_COUNT"

psql_cmd -q -f "$MIGRATION"
V1_CATALOG_AFTER_FIRST="$(v1_catalog_digest)"
V1_ROWS_AFTER_FIRST="$(v1_row_digest)"
BOUNDARY_AFTER_FIRST="$(boundary_digest)"

assert_equal \
  "v1 rank_history catalog changed outside ACL/RLS metadata" \
  "$V1_CATALOG_BEFORE" "$V1_CATALOG_AFTER_FIRST"
assert_equal "v1 rank_history rows changed during ACL cutover" "$V1_ROWS_BEFORE" "$V1_ROWS_AFTER_FIRST"

# The canonical gateway itself receives no direct table ACL, but a PostgREST
# service JWT still has to SET ROLE service_role and exercise the admin path.
AUTHENTICATOR_SERVICE_COUNT="$(
  psql_as authenticator -Atqc \
    "SET ROLE service_role; SELECT count(*) FROM public.rank_history;"
)"
assert_equal \
  "canonical PostgREST gateway SET ROLE service path" \
  "2" "$AUTHENTICATOR_SERVICE_COUNT"
expect_failure_as_contains \
  "authenticator-direct-select" \
  "permission denied for table rank_history" \
  "authenticator" \
  "SELECT * FROM public.rank_history;"

# A direct inherited member can use the service ACL and service-only policy.
# The migration must refuse to run rather than leaving the raw-table boundary
# apparently converged while this noncanonical reader remains effective.
psql_cmd -q -c \
  "GRANT service_role TO inherited_reader WITH INHERIT TRUE, SET FALSE"
INHERITED_READER_COUNT="$(
  psql_as inherited_reader -Atqc "SELECT count(*) FROM public.rank_history;"
)"
assert_equal \
  "inherited service-role reader reaches raw rank_history before rejection" \
  "2" "$INHERITED_READER_COUNT"
expect_migration_failure \
  "inherited-service-role-reader" \
  "rank_history internal role authority graph is unsafe"
assert_equal \
  "failed inherited-reader cutover leaves ACL/RLS metadata unchanged" \
  "$BOUNDARY_AFTER_FIRST" "$(boundary_digest)"
psql_cmd -q -c "REVOKE service_role FROM inherited_reader"

# PostgreSQL 17 stores SET independently of a role's INHERIT default. A
# NOINHERIT setter_reader must therefore also be blocked when it can traverse
# setter_reader -> setter_bridge -> authenticator -> service_role with SET ROLE.
psql_cmd -q <<'SQL'
GRANT authenticator TO setter_bridge WITH INHERIT FALSE, SET TRUE;
GRANT setter_bridge TO setter_reader WITH INHERIT FALSE, SET TRUE;
SQL
SETTER_READER_COUNT="$(
  psql_as setter_reader -Atqc \
    "SET ROLE setter_bridge; SET ROLE authenticator; SET ROLE service_role; SELECT count(*) FROM public.rank_history;"
)"
assert_equal \
  "multi-hop SET ROLE reader reaches raw rank_history before rejection" \
  "2" "$SETTER_READER_COUNT"
expect_migration_failure \
  "setter-reader-multihop-set-role" \
  "rank_history internal role authority graph is unsafe"
assert_equal \
  "failed setter-reader cutover leaves ACL/RLS metadata unchanged" \
  "$BOUNDARY_AFTER_FIRST" "$(boundary_digest)"
psql_cmd -q <<'SQL'
REVOKE setter_bridge FROM setter_reader;
REVOKE authenticator FROM setter_bridge;
SQL

# ADMIN-only membership is authority too: admin_bridge cannot directly SET
# authenticator, but it can delegate that role to a reader that can. The fixed
# migration must reject the bridge before delegation and still reject once the
# delegated reader demonstrates the eventual raw-read path.
psql_cmd -q -c \
  "GRANT authenticator TO admin_bridge WITH ADMIN TRUE, INHERIT FALSE, SET FALSE"
expect_migration_failure \
  "admin-only-authenticator-delegator" \
  "rank_history internal role authority graph is unsafe"
psql_as admin_bridge -q -c \
  "GRANT authenticator TO delegated_reader WITH INHERIT FALSE, SET TRUE"
DELEGATED_READER_COUNT="$(
  psql_as delegated_reader -Atqc \
    "SET ROLE authenticator; SET ROLE service_role; SELECT count(*) FROM public.rank_history;"
)"
assert_equal \
  "ADMIN-only bridge can delegate a raw rank_history SET ROLE reader" \
  "2" "$DELEGATED_READER_COUNT"
expect_migration_failure \
  "delegated-reader-through-admin-bridge" \
  "rank_history internal role authority graph is unsafe"
assert_equal \
  "failed ADMIN-path cutover leaves ACL/RLS metadata unchanged" \
  "$BOUNDARY_AFTER_FIRST" "$(boundary_digest)"
psql_as admin_bridge -q -c "REVOKE authenticator FROM delegated_reader"
psql_cmd -q -c "REVOKE authenticator FROM admin_bridge"

# Replay must converge on the same service-only ACL/RLS metadata once hostile
# role edges are removed, and must not mutate the original v1 relation catalog.
psql_cmd -q -f "$MIGRATION"
V1_CATALOG_AFTER_REPLAY="$(v1_catalog_digest)"
V1_ROWS_AFTER_REPLAY="$(v1_row_digest)"
BOUNDARY_AFTER_REPLAY="$(boundary_digest)"
assert_equal \
  "v1 rank_history catalog changed outside ACL/RLS metadata on replay" \
  "$V1_CATALOG_BEFORE" "$V1_CATALOG_AFTER_REPLAY"
assert_equal \
  "v1 rank_history rows changed during ACL cutover replay" \
  "$V1_ROWS_BEFORE" "$V1_ROWS_AFTER_REPLAY"
assert_equal "prove replay stability" "$BOUNDARY_AFTER_FIRST" "$BOUNDARY_AFTER_REPLAY"

psql_cmd -q <<'SQL'
DO $assertions$
DECLARE
  v_relation oid := 'public.rank_history'::pg_catalog.regclass;
  v_role name;
  v_privilege text;
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = v_relation
         AND relation.relrowsecurity
     ) THEN
    RAISE EXCEPTION 'rank_history RLS was disabled';
  END IF;

  IF (
       SELECT count(*)
       FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid = v_relation
     ) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid = v_relation
         AND policy.polname = 'rank_history_service_only'
         AND policy.polpermissive
         AND policy.polcmd = '*'
         AND policy.polroles = ARRAY['service_role'::regrole::oid]::oid[]
         AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
         AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
     ) THEN
    RAISE EXCEPTION 'rank_history service policy contract failed';
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
    RAISE EXCEPTION 'rank_history retained a non-service table ACL';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
       WHERE attribute.attrelid = v_relation
         AND attribute.attacl IS NOT NULL
         AND privilege.grantee <> 'postgres'::regrole
     ) THEN
    RAISE EXCEPTION 'rank_history retained a non-owner column ACL';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'anon'::name,
    'authenticated'::name,
    'authenticator'::name,
    'inherited_reader'::name,
    'setter_reader'::name,
    'admin_bridge'::name,
    'delegated_reader'::name,
    'delegated_table_reader'::name,
    'delegated_column_reader'::name
  ]
  LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE',
      'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(v_role, v_relation, v_privilege) THEN
        RAISE EXCEPTION '% still has direct rank_history %', v_role, v_privilege;
      END IF;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
    ]::text[]
    LOOP
      IF pg_catalog.has_any_column_privilege(v_role, v_relation, v_privilege) THEN
        RAISE EXCEPTION '% still has column rank_history %', v_role, v_privilege;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH v_privilege IN ARRAY ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE'
  ]::text[]
  LOOP
    IF NOT pg_catalog.has_table_privilege('service_role', v_relation, v_privilege) THEN
      RAISE EXCEPTION 'service_role is missing rank_history %', v_privilege;
    END IF;
  END LOOP;

  IF pg_catalog.pg_has_role('anon', 'service_role', 'MEMBER')
     OR pg_catalog.pg_has_role('authenticated', 'service_role', 'MEMBER') THEN
    RAISE EXCEPTION 'browser role can assume service_role';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.roleid = 'service_role'::pg_catalog.regrole
         AND membership.member = 'authenticator'::pg_catalog.regrole
         AND NOT membership.admin_option
         AND NOT membership.inherit_option
         AND membership.set_option
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.roleid = 'service_role'::pg_catalog.regrole
         AND membership.member NOT IN (
           'postgres'::pg_catalog.regrole,
           'authenticator'::pg_catalog.regrole
         )
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.roleid = 'postgres'::pg_catalog.regrole
     ) THEN
    RAISE EXCEPTION 'rank_history role topology did not converge';
  END IF;
END
$assertions$;
SQL

# anonymous direct SELECT is denied
expect_failure_contains \
  "anonymous-direct-select" \
  "permission denied for table rank_history" \
  "SET ROLE anon; SELECT * FROM public.rank_history;"

# authenticated direct SELECT is denied
expect_failure_contains \
  "authenticated-direct-select" \
  "permission denied for table rank_history" \
  "SET ROLE authenticated; SELECT * FROM public.rank_history;"

expect_failure_as_contains \
  "inherited-reader-direct-select-after-recovery" \
  "permission denied for table rank_history" \
  "inherited_reader" \
  "SELECT * FROM public.rank_history;"

expect_failure_as_contains \
  "setter-reader-direct-select-after-recovery" \
  "permission denied for table rank_history" \
  "setter_reader" \
  "SELECT * FROM public.rank_history;"

expect_failure_as_contains \
  "delegated-reader-direct-select-after-recovery" \
  "permission denied for table rank_history" \
  "delegated_reader" \
  "SELECT * FROM public.rank_history;"

expect_failure_as_contains \
  "setter-reader-role-escalation-after-recovery" \
  "permission denied to set role \"setter_bridge\"" \
  "setter_reader" \
  "SET ROLE setter_bridge;"

expect_failure_contains \
  "delegated-table-reader-direct-select" \
  "permission denied for table rank_history" \
  "SET ROLE delegated_table_reader; SELECT * FROM public.rank_history;"

expect_failure_contains \
  "delegated-column-reader-direct-select" \
  "permission denied for table rank_history" \
  "SET ROLE delegated_column_reader; SELECT rank FROM public.rank_history;"

# service-role snapshot upsert and cleanup CRUD. The fixture intentionally uses
# NOBYPASSRLS, which proves the policy as well as the ACL needed by the admin
# client paths in snapshot-ranks and ranking-change notification jobs.
psql_cmd -q <<'SQL'
SET ROLE service_role;

SELECT count(*) FROM public.rank_history;

INSERT INTO public.rank_history(
  platform, trader_key, period, rank, arena_score, snapshot_date
) VALUES (
  'binance_futures', 'seed', '90D', 4, 91.50, DATE '2026-08-16'
)
ON CONFLICT (platform, trader_key, period, snapshot_date)
DO UPDATE SET
  rank = EXCLUDED.rank,
  arena_score = EXCLUDED.arena_score;

INSERT INTO public.rank_history(
  platform, trader_key, period, rank, arena_score, snapshot_date
) VALUES (
  'binance_futures', 'fresh-service-row', '90D', 9, 75.25, DATE '2026-08-17'
);

UPDATE public.rank_history
SET arena_score = 76.00
WHERE platform = 'binance_futures'
  AND trader_key = 'fresh-service-row'
  AND period = '90D'
  AND snapshot_date = DATE '2026-08-17';

DELETE FROM public.rank_history
WHERE snapshot_date < DATE '2026-08-01';

DELETE FROM public.rank_history
WHERE platform = 'binance_futures'
  AND trader_key = 'fresh-service-row'
  AND period = '90D'
  AND snapshot_date = DATE '2026-08-17';

RESET ROLE;

DO $service_assertions$
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM public.rank_history
       WHERE platform = 'binance_futures'
         AND trader_key = 'seed'
         AND period = '90D'
         AND snapshot_date = DATE '2026-08-16'
         AND rank = 4
         AND arena_score = 91.50
     ) THEN
    RAISE EXCEPTION 'service upsert did not preserve snapshot-ranks contract';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM public.rank_history
       WHERE trader_key IN ('stale', 'fresh-service-row')
     ) THEN
    RAISE EXCEPTION 'service cleanup/delete contract failed';
  END IF;
END
$service_assertions$;
SQL

expect_failure_contains \
  "service-role-unneeded-truncate" \
  "permission denied for table rank_history" \
  "SET ROLE service_role; TRUNCATE public.rank_history;"

echo "rank-history-service-only-acl PostgreSQL 17 proof passed"
