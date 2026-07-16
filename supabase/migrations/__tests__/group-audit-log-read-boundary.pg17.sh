#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the server-owned group audit-log boundary.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716173000_group_audit_log_read_boundary.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ ! -f "$MIGRATION" ]]; then
  echo "Group audit-log boundary migration is missing: $MIGRATION" >&2
  exit 1
fi
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/group-audit-log-boundary-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55473
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
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE drifted_reader NOLOGIN;
GRANT drifted_reader TO authenticated WITH INHERIT TRUE, SET FALSE;

CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  name text NOT NULL
);
ALTER TABLE public.groups OWNER TO postgres;
GRANT SELECT, DELETE ON TABLE public.groups TO service_role;

CREATE TABLE public.group_audit_log (
  id uuid PRIMARY KEY,
  group_id uuid REFERENCES public.groups(id) ON DELETE CASCADE,
  actor_id uuid,
  action text NOT NULL,
  target_id uuid,
  details jsonb,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  internal_note text
);
ALTER TABLE public.group_audit_log OWNER TO postgres;

GRANT ALL PRIVILEGES ON TABLE public.group_audit_log
  TO PUBLIC, anon, authenticated, service_role, drifted_reader;
GRANT SELECT (details, internal_note), UPDATE (internal_note)
  ON TABLE public.group_audit_log TO drifted_reader;
GRANT SELECT (internal_note)
  ON TABLE public.group_audit_log TO PUBLIC;

CREATE POLICY unsafe_public_read
  ON public.group_audit_log
  FOR SELECT
  TO PUBLIC
  USING (true);
CREATE POLICY unknown_drifted_write
  ON public.group_audit_log
  FOR ALL
  TO drifted_reader
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.append_group_audit_evidence(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  INSERT INTO public.group_audit_log (id, action, details)
  VALUES (p_id, 'definer_append', '{}'::jsonb)
$function$;
ALTER FUNCTION public.append_group_audit_evidence(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.append_group_audit_evidence(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_group_audit_evidence(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.expect_denied(p_statement text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  EXECUTE p_statement;
  RAISE EXCEPTION 'statement unexpectedly succeeded: %', p_statement;
EXCEPTION
  WHEN insufficient_privilege OR check_violation THEN
    RETURN;
END
$function$;
GRANT EXECUTE ON FUNCTION public.expect_denied(text)
  TO anon, authenticated, service_role, drifted_reader;

INSERT INTO public.groups (id, name) VALUES (
  '20000000-0000-4000-8000-000000000002',
  'Cascade proof'
);
INSERT INTO public.group_audit_log (
  id, group_id, actor_id, action, target_id, details, internal_note
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',
  'member_kicked',
  '40000000-0000-4000-8000-000000000004',
  '{"private_reason":"must not reach browsers"}'::jsonb,
  'out-of-band extra column'
);
SQL

psql_cmd -f "$MIGRATION" >"$LOG_DIR/first-application.log"
psql_cmd -f "$MIGRATION" >"$LOG_DIR/second-application.log"

psql_cmd <<'SQL'
DO $catalog_contract$
DECLARE
  postgres_oid oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres');
  service_oid oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role');
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_audit_log'::pg_catalog.regclass
      AND relation.relowner = postgres_oid
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_audit_log'::pg_catalog.regclass
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.group_audit_log'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> postgres_oid
  ) THEN
    RAISE EXCEPTION 'audit-log RLS/policy/column ACL catalog contract failed';
  END IF;

  IF EXISTS (
    WITH expected(grantee, grantor, privilege_type, is_grantable) AS (
      VALUES
        (service_oid, postgres_oid, 'SELECT'::text, false),
        (service_oid, postgres_oid, 'INSERT'::text, false)
    ),
    actual AS (
      SELECT acl_entry.grantee,
             acl_entry.grantor,
             acl_entry.privilege_type::text,
             acl_entry.is_grantable
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl_entry
      WHERE relation.oid = 'public.group_audit_log'::pg_catalog.regclass
        AND acl_entry.grantee <> relation.relowner
    )
    SELECT 1
    FROM expected
    FULL JOIN actual
      USING (grantee, grantor, privilege_type, is_grantable)
    WHERE expected.grantee IS NULL OR actual.grantee IS NULL
  ) THEN
    RAISE EXCEPTION 'audit-log table ACL catalog contract failed';
  END IF;
END
$catalog_contract$;

SET ROLE anon;
SELECT public.expect_denied('SELECT id FROM public.group_audit_log');
SELECT public.expect_denied($statement$
  INSERT INTO public.group_audit_log (id, action, details)
  VALUES ('70000000-0000-4000-8000-000000000007', 'browser_append', '{}')
$statement$);
RESET ROLE;

SET ROLE authenticated;
SELECT public.expect_denied('SELECT details FROM public.group_audit_log');
SELECT public.expect_denied($statement$
  INSERT INTO public.group_audit_log (id, action, details)
  VALUES ('80000000-0000-4000-8000-000000000008', 'browser_append', '{}')
$statement$);
RESET ROLE;

SET ROLE drifted_reader;
SELECT public.expect_denied('SELECT internal_note FROM public.group_audit_log');
RESET ROLE;

SET ROLE service_role;
DO $service_read_contract$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.group_audit_log) <> 1 THEN
    RAISE EXCEPTION 'service_role lost audit-log SELECT';
  END IF;
END
$service_read_contract$;
INSERT INTO public.group_audit_log (id, action)
VALUES ('50000000-0000-4000-8000-000000000005', 'service_append');
SELECT public.append_group_audit_evidence(
  '60000000-0000-4000-8000-000000000006'
);
SELECT public.expect_denied(
  'UPDATE public.group_audit_log SET action = ''tampered'''
);
SELECT public.expect_denied('DELETE FROM public.group_audit_log');
DELETE FROM public.groups
WHERE id = '20000000-0000-4000-8000-000000000002';
RESET ROLE;

DO $writer_contract$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.group_audit_log) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM public.group_audit_log WHERE action = 'definer_append'
     )
     OR EXISTS (
       SELECT 1
       FROM public.group_audit_log
       WHERE group_id = '20000000-0000-4000-8000-000000000002'
     )
  THEN
    RAISE EXCEPTION 'service/definer append or parent cascade contract failed';
  END IF;
END
$writer_contract$;
SQL

# An inheritable edge from a browser role to service_role would bypass both the
# zero-policy RLS and the exact direct ACL. The migration must reject that drift.
psql_cmd <<'SQL'
GRANT service_role TO authenticated WITH INHERIT TRUE, SET FALSE;
SQL
if psql_cmd -f "$MIGRATION" >"$LOG_DIR/inherited-service-drift.log" 2>&1; then
  echo "Migration accepted authenticated inheritance of service_role" >&2
  exit 1
fi
psql_cmd <<'SQL'
REVOKE service_role FROM authenticated;
SQL
psql_cmd -f "$MIGRATION" >"$LOG_DIR/post-drift-replay.log"

echo "group audit-log read boundary PG17 proof passed"
