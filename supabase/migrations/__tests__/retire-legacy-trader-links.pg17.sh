#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the retired trader_links boundary. It owns
# an isolated cluster and never connects to a developer or remote database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716111500_retire_legacy_trader_links.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/retired-trader-links-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55468
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
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
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
CREATE ROLE service_role NOLOGIN BYPASSRLS;
SQL

# Missing-table preflight must fail before changing any ACL.
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/preflight.log" 2>&1; then
  echo "legacy ACL migration unexpectedly passed without trader_links" >&2
  exit 1
fi
if ! grep -q 'public.trader_links must exist before retiring its ACL' \
  "$TMP_ROOT/preflight.log"; then
  cat "$TMP_ROOT/preflight.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
CREATE TABLE public.trader_links (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  trader_id text NOT NULL,
  source text NOT NULL,
  handle text,
  verified_at timestamptz,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.trader_links ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.trader_links TO anon, authenticated, service_role;
GRANT SELECT (trader_id), INSERT (handle), UPDATE (handle), REFERENCES (id)
  ON TABLE public.trader_links TO PUBLIC, anon, authenticated, service_role;

CREATE POLICY "Users can view own links"
  ON public.trader_links FOR SELECT TO public USING (true);
CREATE POLICY "Users can insert own links"
  ON public.trader_links FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Users can delete own links"
  ON public.trader_links FOR DELETE TO public USING (true);
CREATE POLICY unknown_drift_write
  ON public.trader_links FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

INSERT INTO public.trader_links (
  id, user_id, trader_id, source, handle, verified_at
) VALUES
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '11111111-1111-4111-8111-111111111111',
    'trader-a',
    'binance',
    'alpha',
    pg_catalog.clock_timestamp()
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    '22222222-2222-4222-8222-222222222222',
    'trader-b',
    'bybit',
    'beta',
    pg_catalog.clock_timestamp()
  );

CREATE FUNCTION public.expect_denied(p_statement text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  EXECUTE p_statement;
  RAISE EXCEPTION 'statement unexpectedly succeeded: %', p_statement;
EXCEPTION
  WHEN insufficient_privilege THEN
    RETURN;
END
$function$;
GRANT EXECUTE ON FUNCTION public.expect_denied(text)
  TO anon, authenticated, service_role;
SQL

# Replay twice: policy replacement and ACL revocation must converge.
psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
SET ROLE anon;
SELECT public.expect_denied('SELECT * FROM public.trader_links');
SELECT public.expect_denied($statement$
  INSERT INTO public.trader_links (id, user_id, trader_id, source)
  VALUES (
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
    '33333333-3333-4333-8333-333333333333',
    'forged-anon',
    'binance'
  )
$statement$);
RESET ROLE;

SET ROLE authenticated;
SELECT public.expect_denied('SELECT * FROM public.trader_links');
SELECT public.expect_denied($statement$
  UPDATE public.trader_links SET handle = 'forged'
$statement$);
SELECT public.expect_denied($statement$
  DELETE FROM public.trader_links
$statement$);
SELECT public.expect_denied('TRUNCATE public.trader_links');
RESET ROLE;

SET ROLE service_role;
DO $service_read$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.trader_links) <> 2 THEN
    RAISE EXCEPTION 'service compatibility read failed';
  END IF;
END
$service_read$;
SELECT public.expect_denied($statement$
  INSERT INTO public.trader_links (id, user_id, trader_id, source)
  VALUES (
    'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
    '44444444-4444-4444-8444-444444444444',
    'service-write',
    'okx'
  )
$statement$);
SELECT public.expect_denied('UPDATE public.trader_links SET handle = ''service-write''');
SELECT public.expect_denied('DELETE FROM public.trader_links');
SELECT public.expect_denied('TRUNCATE public.trader_links');
RESET ROLE;

DO $final_contract$
DECLARE
  service_oid oid := (
    SELECT role.oid FROM pg_catalog.pg_roles AS role
    WHERE role.rolname = 'service_role'
  );
BEGIN
  IF pg_catalog.has_table_privilege(
       'anon', 'public.trader_links',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.trader_links',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_any_column_privilege(
       'authenticated', 'public.trader_links',
       'SELECT,INSERT,UPDATE,REFERENCES'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.trader_links', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'public.trader_links',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'final retired trader_links privilege contract failed';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = 'public.trader_links'::regclass) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid = 'public.trader_links'::regclass
         AND policy.polname = 'legacy_trader_links_service_read'
         AND policy.polcmd = 'r'
         AND policy.polroles = ARRAY[service_oid]
     ) THEN
    RAISE EXCEPTION 'final retired trader_links policy contract failed';
  END IF;
END
$final_contract$;
SQL

echo "retired trader_links PG17 integration proof passed"
