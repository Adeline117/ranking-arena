#!/usr/bin/env bash

# PostgreSQL 17 hostile-fixture proof for the trader-activities publication
# fence. It runs against a disposable local cluster only: legacy PUBLIC,
# delegated table/column ACLs, and unsafe recursive role paths must all fail
# closed while the normal authenticator -> service_role SET-only bridge works.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20261111132445_trader_activities_publication_fence_hosted_role_graph.sql"
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

TMP_ROOT="$(mktemp -d /tmp/trader-activities-publication-fence-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((56000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    echo "[trader-activities-publication-fence] PostgreSQL log tail:" >&2
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

psql_as_authenticator() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U authenticator -d postgres "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "[trader-activities-publication-fence] $label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

expect_failure_contains() {
  local label="$1"
  local needle="$2"
  local sql="$3"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"

  if psql_cmd -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "[trader-activities-publication-fence] Expected failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[trader-activities-publication-fence] Unexpected failure for $label" >&2
    sed -n '1,180p' "$failure_log" >&2
    exit 1
  fi
}

expect_authenticator_failure_contains() {
  local label="$1"
  local needle="$2"
  local sql="$3"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"

  if psql_as_authenticator -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "[trader-activities-publication-fence] Expected authenticator failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[trader-activities-publication-fence] Unexpected authenticator failure for $label" >&2
    sed -n '1,180p' "$failure_log" >&2
    exit 1
  fi
}

expect_migration_failure() {
  local label="$1"
  local needle="$2"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"

  if psql_cmd -v VERBOSITY=verbose -f "$MIGRATION" >"$failure_log" 2>&1; then
    echo "[trader-activities-publication-fence] Expected migration failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[trader-activities-publication-fence] Unexpected migration failure for $label" >&2
    sed -n '1,220p' "$failure_log" >&2
    exit 1
  fi
}

v1_catalog_digest() {
  psql_cmd -Atq <<'SQL'
WITH identities AS (
  SELECT
    'relation:' || relation.oid::text || ':' || relation.relkind::text || ':' ||
      relation.relowner::text || ':' || relation.relpersistence::text || ':' ||
      relation.relnatts::text AS identity
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'public.trader_activities'::pg_catalog.regclass

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
  WHERE attribute.attrelid = 'public.trader_activities'::pg_catalog.regclass
    AND attribute.attnum > 0

  UNION ALL

  SELECT
    'constraint:' || constraint_row.conname || ':' || constraint_row.contype::text || ':' ||
      constraint_row.condeferrable::text || ':' || constraint_row.condeferred::text || ':' ||
      pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS identity
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'public.trader_activities'::pg_catalog.regclass

  UNION ALL

  SELECT
    'index:' || index_class.relname || ':' || index_row.indisprimary::text || ':' ||
      index_row.indisunique::text || ':' || pg_catalog.pg_get_indexdef(index_row.indexrelid) AS identity
  FROM pg_catalog.pg_index AS index_row
  JOIN pg_catalog.pg_class AS index_class
    ON index_class.oid = index_row.indexrelid
  WHERE index_row.indrelid = 'public.trader_activities'::pg_catalog.regclass
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
          activity.id::text || ':' ||
            COALESCE(activity.source, '<null>') || ':' ||
            COALESCE(activity.source_trader_id, '<null>') || ':' ||
            activity.activity_type || ':' || activity.activity_text || ':' ||
            COALESCE(activity.metric_value::text, '<null>') || ':' ||
            COALESCE(activity.metric_label, '<null>') || ':' ||
            activity.occurred_at::text,
          '|' ORDER BY activity.id
        ),
        ''
      ),
      'UTF8'
    )
  ),
  'hex'
)
FROM public.trader_activities AS activity;
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
  WHERE relation.oid = 'public.trader_activities'::pg_catalog.regclass

  UNION ALL

  SELECT
    'policy:' || policy.polname || ':' || policy.polpermissive::text || ':' ||
      policy.polcmd::text || ':' || policy.polroles::text || ':' ||
      COALESCE(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), '<null>') || ':' ||
      COALESCE(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), '<null>') AS identity
  FROM pg_catalog.pg_policy AS policy
  WHERE policy.polrelid = 'public.trader_activities'::pg_catalog.regclass

  UNION ALL

  SELECT
    'column:' || attribute.attnum::text || ':' ||
      COALESCE(attribute.attacl::text, '<null>') AS identity
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.trader_activities'::pg_catalog.regclass
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

echo "[trader-activities-publication-fence] build hostile legacy fixture"
psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE table_delegator NOLOGIN NOBYPASSRLS;
CREATE ROLE delegated_table_reader NOLOGIN NOBYPASSRLS;
CREATE ROLE delegated_column_reader NOLOGIN NOBYPASSRLS;
CREATE ROLE rogue_member NOLOGIN NOBYPASSRLS;
CREATE ROLE elevated_authority NOLOGIN NOBYPASSRLS;
CREATE ROLE admin_bridge NOLOGIN NOBYPASSRLS;
CREATE ROLE setter NOLOGIN NOBYPASSRLS;

GRANT USAGE ON SCHEMA public
  TO anon, authenticated, service_role, authenticator, table_delegator,
     delegated_table_reader, delegated_column_reader, rogue_member,
     elevated_authority, admin_bridge, setter;

-- This is the normal gateway edge the migration preserves: authenticator may
-- SET ROLE service_role for a service JWT but cannot inherit its privileges.
GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE;

CREATE TABLE public.trader_activities (
  id uuid PRIMARY KEY,
  source text,
  source_trader_id text,
  handle text,
  avatar_url text,
  activity_type text NOT NULL,
  activity_text text NOT NULL,
  metric_value numeric,
  metric_label text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.trader_activities ENABLE ROW LEVEL SECURITY;

-- Legacy broad REST grants, a delegated table grant, and independently
-- delegated column grants must all collapse to exact service CRUD.
GRANT ALL ON TABLE public.trader_activities
  TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.trader_activities TO table_delegator WITH GRANT OPTION;
SET ROLE table_delegator;
GRANT SELECT ON TABLE public.trader_activities TO delegated_table_reader;
RESET ROLE;
GRANT SELECT (activity_text, metric_value), UPDATE (metric_value)
  ON TABLE public.trader_activities TO delegated_column_reader;

CREATE POLICY "Anyone can read trader activities"
  ON public.trader_activities FOR SELECT TO PUBLIC USING (true);
CREATE POLICY drifted_authenticated_activity_reader
  ON public.trader_activities FOR SELECT TO authenticated USING (true);
CREATE POLICY drifted_service_writer
  ON public.trader_activities FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.trader_activities (
  id, source, source_trader_id, handle, activity_type, activity_text,
  metric_value, metric_label, occurred_at
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  'binance_futures', 'legacy-trader', 'legacy', 'roi_milestone',
  'Legacy raw activity: 500% ROI and rank #1', 500, 'ROI %',
  TIMESTAMPTZ '2026-08-17 00:00:00+00'
);

-- Hostile recursive SET path: rogue_member -> authenticator -> service_role.
GRANT authenticator TO rogue_member WITH INHERIT FALSE, SET TRUE;
SQL

PRE_CUTOVER_COUNT="$(psql_cmd -Atqc "SET ROLE anon; SELECT count(*) FROM public.trader_activities;")"
assert_equal "historical anonymous raw read" "1" "$PRE_CUTOVER_COUNT"

expect_migration_failure \
  "recursive-set-path" \
  "trader_activities service_role membership or SET graph is unsafe"

# The migration must fail before ACL mutation while the recursive path exists.
POST_FAILED_CUTOVER_COUNT="$(psql_cmd -Atqc "SET ROLE anon; SELECT count(*) FROM public.trader_activities;")"
assert_equal "unsafe graph left legacy fixture untouched" "1" "$POST_FAILED_CUTOVER_COUNT"

psql_cmd -q -c "REVOKE authenticator FROM rogue_member;"

V1_CATALOG_BEFORE="$(v1_catalog_digest)"
V1_ROWS_BEFORE="$(v1_row_digest)"

if [[ "${SUPABASE_MANAGED_GRAPH_PROOF:-0}" == "1" ]]; then
  # shellcheck source=lib/supabase-managed-graph-proof.sh
  source "$ROOT_DIR/supabase/migrations/__tests__/lib/supabase-managed-graph-proof.sh"
  run_supabase_managed_graph_proof
  exit 0
fi

psql_cmd -q -f "$MIGRATION"
V1_CATALOG_AFTER_FIRST="$(v1_catalog_digest)"
V1_ROWS_AFTER_FIRST="$(v1_row_digest)"
BOUNDARY_AFTER_FIRST="$(boundary_digest)"

# Replay must converge to the same ACL/RLS metadata and leave the v1 schema and
# rows intact.
psql_cmd -q -f "$MIGRATION"
V1_CATALOG_AFTER_REPLAY="$(v1_catalog_digest)"
V1_ROWS_AFTER_REPLAY="$(v1_row_digest)"
BOUNDARY_AFTER_REPLAY="$(boundary_digest)"
assert_equal \
  "v1 trader_activities catalog changed outside ACL/RLS metadata" \
  "$V1_CATALOG_BEFORE" "$V1_CATALOG_AFTER_FIRST"
assert_equal \
  "v1 trader_activities catalog changed outside ACL/RLS metadata on replay" \
  "$V1_CATALOG_BEFORE" "$V1_CATALOG_AFTER_REPLAY"
assert_equal \
  "v1 trader_activities rows changed during ACL cutover" \
  "$V1_ROWS_BEFORE" "$V1_ROWS_AFTER_FIRST"
assert_equal \
  "v1 trader_activities rows changed during ACL cutover replay" \
  "$V1_ROWS_BEFORE" "$V1_ROWS_AFTER_REPLAY"
assert_equal "prove replay stability" "$BOUNDARY_AFTER_FIRST" "$BOUNDARY_AFTER_REPLAY"

psql_cmd -q <<'SQL'
DO $assertions$
DECLARE
  v_relation oid := 'public.trader_activities'::pg_catalog.regclass;
  v_service oid := 'service_role'::pg_catalog.regrole;
  v_authenticator oid := 'authenticator'::pg_catalog.regrole;
  v_postgres oid := 'postgres'::pg_catalog.regrole;
  v_role name;
  v_privilege text;
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = v_relation
         AND relation.relrowsecurity
     ) THEN
    RAISE EXCEPTION 'trader_activities RLS was disabled';
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
         AND policy.polname = 'trader_activities_service_role_only'
         AND policy.polpermissive
         AND policy.polcmd = '*'
         AND policy.polroles = ARRAY[v_service]::oid[]
         AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
         AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
     ) THEN
    RAISE EXCEPTION 'trader_activities service policy contract failed';
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
           privilege.grantee <> v_service
           OR privilege.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
           OR privilege.is_grantable
         )
     ) THEN
    RAISE EXCEPTION 'trader_activities retained a non-service table ACL';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
       WHERE attribute.attrelid = v_relation
         AND attribute.attacl IS NOT NULL
         AND privilege.grantee <> 'postgres'::pg_catalog.regrole
     ) THEN
    RAISE EXCEPTION 'trader_activities retained a non-owner column ACL';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'anon'::name,
    'authenticated'::name,
    'authenticator'::name,
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
        RAISE EXCEPTION '% still has trader_activities %', v_role, v_privilege;
      END IF;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
    ]::text[]
    LOOP
      IF pg_catalog.has_any_column_privilege(v_role, v_relation, v_privilege) THEN
        RAISE EXCEPTION '% still has trader_activities column %', v_role, v_privilege;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH v_privilege IN ARRAY ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE'
  ]::text[]
  LOOP
    IF NOT pg_catalog.has_table_privilege('service_role', v_relation, v_privilege) THEN
      RAISE EXCEPTION 'service_role is missing trader_activities %', v_privilege;
    END IF;
  END LOOP;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.roleid = v_service
         AND membership.member = v_authenticator
         AND NOT membership.admin_option
         AND NOT membership.inherit_option
         AND membership.set_option
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.roleid = v_service
         AND membership.member NOT IN (v_authenticator, v_postgres)
     ) OR EXISTS (
       WITH RECURSIVE service_reachers(role_oid) AS (
         SELECT membership.member
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.roleid = v_service
           AND (membership.inherit_option OR membership.set_option OR membership.admin_option)
         UNION
         SELECT membership.member
         FROM pg_catalog.pg_auth_members AS membership
         JOIN service_reachers AS reachable
           ON membership.roleid = reachable.role_oid
         WHERE membership.inherit_option OR membership.set_option OR membership.admin_option
       )
       SELECT 1
       FROM service_reachers AS reachable
       WHERE reachable.role_oid NOT IN (v_authenticator, v_postgres)
     ) OR EXISTS (
       WITH RECURSIVE service_outbound(role_oid) AS (
         SELECT membership.roleid
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.member = v_service
           AND (membership.inherit_option OR membership.set_option OR membership.admin_option)
         UNION
         SELECT membership.roleid
         FROM pg_catalog.pg_auth_members AS membership
         JOIN service_outbound AS reachable
           ON membership.member = reachable.role_oid
         WHERE membership.inherit_option OR membership.set_option OR membership.admin_option
       )
       SELECT 1 FROM service_outbound
     ) THEN
    RAISE EXCEPTION 'trader_activities role graph did not converge';
  END IF;
END
$assertions$;
SQL

expect_failure_contains \
  "anonymous-direct-select" \
  "permission denied for table trader_activities" \
  "SET ROLE anon; SELECT * FROM public.trader_activities;"

expect_failure_contains \
  "authenticated-direct-select" \
  "permission denied for table trader_activities" \
  "SET ROLE authenticated; SELECT * FROM public.trader_activities;"

expect_failure_contains \
  "delegated-table-reader-direct-select" \
  "permission denied for table trader_activities" \
  "SET ROLE delegated_table_reader; SELECT * FROM public.trader_activities;"

expect_failure_contains \
  "delegated-column-reader-direct-select" \
  "permission denied for table trader_activities" \
  "SET ROLE delegated_column_reader; SELECT activity_text FROM public.trader_activities;"

expect_authenticator_failure_contains \
  "authenticator-does-not-inherit-service" \
  "permission denied for table trader_activities" \
  "SELECT * FROM public.trader_activities;"

# Browser role cannot enter the service role; this evaluates after the session
# identity is changed away from postgres, so superuser SET ROLE is not masking
# the actual membership graph.
expect_failure_contains \
  "anon-cannot-set-service-role" \
  "permission denied to set role" \
  "SET SESSION AUTHORIZATION anon; SET ROLE service_role;"

# The normal gateway bridge remains SET-only: a direct authenticator session
# cannot read, then assumes service_role and gets the exact server CRUD path.
AUTHENTICATOR_SERVICE_COUNT="$(psql_as_authenticator -Atqc \
  "SET ROLE service_role; SELECT count(*) FROM public.trader_activities;")"
assert_equal "authenticator SET-only bridge reaches service_role" "1" "$AUTHENTICATOR_SERVICE_COUNT"

psql_cmd -q <<'SQL'
SET ROLE service_role;

INSERT INTO public.trader_activities (
  id, source, source_trader_id, handle, activity_type, activity_text,
  metric_value, metric_label, occurred_at
) VALUES (
  '22222222-2222-2222-2222-222222222222',
  'binance_futures', 'service-trader', 'service', 'win_streak',
  'Service-maintained private activity', 3, 'Streak',
  TIMESTAMPTZ '2026-08-17 01:00:00+00'
);

UPDATE public.trader_activities
SET metric_value = 4
WHERE id = '22222222-2222-2222-2222-222222222222';

DELETE FROM public.trader_activities
WHERE id = '22222222-2222-2222-2222-222222222222';

RESET ROLE;
SQL

expect_failure_contains \
  "service-role-unneeded-truncate" \
  "permission denied for table trader_activities" \
  "SET ROLE service_role; TRUNCATE public.trader_activities;"

# A dormant direct member still fails closed, and a recursive outbound SET
# route from service_role is rejected on rerun. Both failures leave the
# converged table boundary intact once the hostile edge is removed.
psql_cmd -q -c "GRANT service_role TO rogue_member WITH INHERIT FALSE, SET FALSE;"
expect_migration_failure \
  "nonnecessary-direct-service-member" \
  "trader_activities service_role membership or SET graph is unsafe"
psql_cmd -q -c "REVOKE service_role FROM rogue_member;"

psql_cmd -q -c "GRANT elevated_authority TO service_role WITH INHERIT FALSE, SET TRUE;"
expect_migration_failure \
  "service-outbound-set-path" \
  "trader_activities service_role membership or SET graph is unsafe"
psql_cmd -q -c "REVOKE elevated_authority FROM service_role;"

# ADMIN OPTION is an authority path even when it is not currently SET or
# inherited: admin_bridge can regrant authenticator to setter, which then gets
# the normal setter -> authenticator -> service_role route. The migration must
# reject the delegation graph before it can become a public-table bypass.
psql_cmd -q <<'SQL'
GRANT authenticator TO admin_bridge WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
SET ROLE admin_bridge;
GRANT authenticator TO setter WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
RESET ROLE;
SQL
expect_migration_failure \
  "admin-option-delegation-path" \
  "trader_activities service_role membership or SET graph is unsafe"
psql_cmd -q <<'SQL'
SET ROLE admin_bridge;
REVOKE authenticator FROM setter;
RESET ROLE;
REVOKE authenticator FROM admin_bridge;
SQL

psql_cmd -q -f "$MIGRATION"
assert_equal "role-graph replay stays converged" "$BOUNDARY_AFTER_REPLAY" "$(boundary_digest)"

echo "trader-activities-publication-fence PostgreSQL 17 proof passed"
