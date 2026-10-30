#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the V1 legacy portfolio retirement boundary.
# This script creates and destroys its own cluster; it never connects to an app DB.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803212000_legacy_portfolios_v1_retirement.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/legacy-portfolio-retirement-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 2000)))}"
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
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

expect_failure() {
  local name="$1"
  local sql="$2"
  if psql_cmd -c "$sql" >"$TMP_ROOT/$name.log" 2>&1; then
    echo "expected failure succeeded: $name" >&2
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
CREATE ROLE hostile_parent NOLOGIN;
CREATE ROLE dashboard_writer NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
-- Match Supabase's service posture: the boundary must come from ACLs and the
-- versioned RPC, not from relying on RLS to constrain service_role.
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT hostile_parent TO anon, authenticated, service_role;
GRANT dashboard_writer TO authenticated, service_role;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);

CREATE TABLE public.user_portfolios (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange text NOT NULL,
  api_key_encrypted text NOT NULL,
  api_secret_encrypted text NOT NULL,
  api_passphrase_encrypted text,
  label text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
CREATE TABLE public.user_positions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.user_portfolios(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  side text NOT NULL,
  entry_price numeric NOT NULL DEFAULT 0,
  mark_price numeric NOT NULL DEFAULT 0,
  size numeric NOT NULL DEFAULT 0,
  pnl numeric NOT NULL DEFAULT 0,
  pnl_pct numeric NOT NULL DEFAULT 0,
  leverage numeric NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
CREATE TABLE public.user_portfolio_snapshots (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.user_portfolios(id) ON DELETE CASCADE,
  total_equity numeric NOT NULL DEFAULT 0,
  total_pnl numeric NOT NULL DEFAULT 0,
  total_pnl_pct numeric NOT NULL DEFAULT 0,
  snapshot_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.user_portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_portfolio_snapshots ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.user_portfolios, public.user_positions,
  public.user_portfolio_snapshots TO PUBLIC, anon, authenticated, service_role,
  hostile_parent;
GRANT SELECT (api_key_encrypted, api_secret_encrypted, api_passphrase_encrypted),
  UPDATE (api_key_encrypted, api_secret_encrypted)
  ON public.user_portfolios TO dashboard_writer;

CREATE POLICY "Users can manage own portfolios"
  ON public.user_portfolios FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "Users can manage own positions"
  ON public.user_positions FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "Out of band snapshot writer"
  ON public.user_portfolio_snapshots FOR ALL TO dashboard_writer
  USING (true) WITH CHECK (true);

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
INSERT INTO public.user_portfolios(
  id, user_id, exchange, api_key_encrypted, api_secret_encrypted,
  api_passphrase_encrypted, label
) VALUES
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    '11111111-1111-1111-1111-111111111111',
    'binance', 'cipher-key-1', 'cipher-secret-1', NULL, 'main'
  ),
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
    '22222222-2222-2222-2222-222222222222',
    'bitget', 'cipher-key-2', 'cipher-secret-2', 'cipher-pass-2', 'other'
  );
INSERT INTO public.user_positions(portfolio_id, symbol, side, entry_price) VALUES
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'BTCUSDT',
    'long',
    9007199254740993.0000000001
  ),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', 'ETHUSDT', 'short', 0);
INSERT INTO public.user_portfolio_snapshots(portfolio_id, total_equity) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 9007199254740993.0000000001),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', 0);

-- CREATE OR REPLACE retains old proacl entries. Seed hostile function grants
-- to prove the migration converges the live catalog, including on replay.
CREATE FUNCTION public.delete_legacy_portfolio_v1(uuid, uuid)
RETURNS boolean LANGUAGE sql AS 'SELECT false';
CREATE FUNCTION public.export_legacy_portfolio_data_v1(uuid)
RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb';
GRANT EXECUTE ON FUNCTION public.delete_legacy_portfolio_v1(uuid, uuid),
  public.export_legacy_portfolio_data_v1(uuid) TO dashboard_writer;
SQL

psql_cmd -q -f "$MIGRATION"
psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
DO $preserved$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_portfolios
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
      AND api_key_encrypted = 'cipher-key-1'
      AND api_secret_encrypted = 'cipher-secret-1'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.user_portfolios
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
      AND api_key_encrypted = 'cipher-key-2'
      AND api_secret_encrypted = 'cipher-secret-2'
      AND api_passphrase_encrypted = 'cipher-pass-2'
  ) THEN
    RAISE EXCEPTION 'retirement migration modified preserved credential rows';
  END IF;
END
$preserved$;

CREATE FUNCTION public.block_legacy_position_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'injected child delete failure';
END
$function$;
CREATE TRIGGER block_legacy_position_delete
BEFORE DELETE ON public.user_positions
FOR EACH ROW
WHEN (OLD.portfolio_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'::uuid)
EXECUTE FUNCTION public.block_legacy_position_delete();
SQL

expect_failure atomic_delete_rollback \
  "SET ROLE service_role; SELECT public.delete_legacy_portfolio_v1('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1')"

psql_cmd -q <<'SQL'
DO $rollback_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_portfolios
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.user_positions
    WHERE portfolio_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.user_portfolio_snapshots
    WHERE portfolio_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  ) THEN
    RAISE EXCEPTION 'failed legacy deletion did not roll back every projection';
  END IF;
END
$rollback_proof$;
DROP TRIGGER block_legacy_position_delete ON public.user_positions;
DROP FUNCTION public.block_legacy_position_delete();
SQL

expect_failure browser_ciphertext \
  "SET ROLE authenticated; SELECT api_key_encrypted FROM public.user_portfolios"
expect_failure browser_forge \
  "SET ROLE authenticated; INSERT INTO public.user_portfolios(user_id,exchange,api_key_encrypted,api_secret_encrypted) VALUES ('11111111-1111-1111-1111-111111111111','okx','x','y')"
expect_failure service_ciphertext \
  "SET ROLE service_role; SELECT api_secret_encrypted FROM public.user_portfolios"
expect_failure service_direct_delete \
  "SET ROLE service_role; DELETE FROM public.user_portfolios WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'"
expect_failure service_direct_insert \
  "SET ROLE service_role; INSERT INTO public.user_portfolios(user_id,exchange,api_key_encrypted,api_secret_encrypted) VALUES ('11111111-1111-1111-1111-111111111111','okx','x','y')"
expect_failure service_direct_update \
  "SET ROLE service_role; UPDATE public.user_portfolios SET label = 'forged' WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'"
expect_failure service_positions \
  "SET ROLE service_role; SELECT * FROM public.user_positions"
expect_failure service_snapshots \
  "SET ROLE service_role; SELECT * FROM public.user_portfolio_snapshots"
expect_failure browser_rpc \
  "SET ROLE authenticated; SELECT public.delete_legacy_portfolio_v1('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1')"
expect_failure browser_export_rpc \
  "SET ROLE authenticated; SELECT public.export_legacy_portfolio_data_v1('11111111-1111-1111-1111-111111111111')"
expect_failure service_export_null_owner \
  "SET ROLE service_role; SELECT public.export_legacy_portfolio_data_v1(NULL)"
expect_failure stale_dashboard_delete_rpc \
  "SET ROLE dashboard_writer; SELECT public.delete_legacy_portfolio_v1('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1')"
expect_failure stale_dashboard_export_rpc \
  "SET ROLE dashboard_writer; SELECT public.export_legacy_portfolio_data_v1('11111111-1111-1111-1111-111111111111')"

psql_cmd -q <<'SQL'
SET ROLE service_role;
SELECT id, user_id, exchange, label, created_at FROM public.user_portfolios
ORDER BY id;

DO $proof$
DECLARE
  v_export jsonb;
BEGIN
  v_export := public.export_legacy_portfolio_data_v1(
    '11111111-1111-1111-1111-111111111111'
  );

  IF pg_catalog.jsonb_array_length(v_export->'portfolios') <> 1
     OR pg_catalog.jsonb_array_length(v_export->'positions') <> 1
     OR pg_catalog.jsonb_array_length(v_export->'snapshots') <> 1
     OR v_export #>> '{portfolios,0,id}'
          <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
     OR v_export #>> '{positions,0,portfolio_id}'
          <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
     OR v_export #>> '{positions,0,symbol}' <> 'BTCUSDT'
     OR v_export #>> '{positions,0,entry_price}' <> '9007199254740993.0000000001'
     OR v_export #>> '{snapshots,0,portfolio_id}'
          <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
     OR v_export #>> '{snapshots,0,total_equity}' <> '9007199254740993.0000000001'
     OR v_export::text LIKE '%cipher%'
     OR v_export::text LIKE '%api_key%'
     OR v_export::text LIKE '%api_secret%'
     OR v_export::text LIKE '%api_passphrase%' THEN
    RAISE EXCEPTION 'owner export was incomplete, cross-owner, or exposed ciphertext: %', v_export;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_export->'portfolios') AS exported_row(row_value)
    CROSS JOIN LATERAL pg_catalog.jsonb_object_keys(row_value) AS key_name
    WHERE key_name NOT IN ('id', 'exchange', 'label', 'created_at')
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_export->'positions') AS exported_row(row_value)
    CROSS JOIN LATERAL pg_catalog.jsonb_object_keys(row_value) AS key_name
    WHERE key_name NOT IN (
      'id', 'portfolio_id', 'symbol', 'side', 'entry_price', 'mark_price',
      'size', 'pnl', 'pnl_pct', 'leverage', 'updated_at'
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_export->'snapshots') AS exported_row(row_value)
    CROSS JOIN LATERAL pg_catalog.jsonb_object_keys(row_value) AS key_name
    WHERE key_name NOT IN (
      'id', 'portfolio_id', 'total_equity', 'total_pnl', 'total_pnl_pct', 'snapshot_at'
    )
  ) THEN
    RAISE EXCEPTION 'legacy portfolio export returned an unapproved field';
  END IF;

  IF public.delete_legacy_portfolio_v1(
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
  ) THEN
    RAISE EXCEPTION 'cross-owner legacy portfolio delete unexpectedly succeeded';
  END IF;

  IF NOT public.delete_legacy_portfolio_v1(
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  ) THEN
    RAISE EXCEPTION 'owner-scoped legacy portfolio delete failed';
  END IF;
END
$proof$;
RESET ROLE;

DO $post_delete$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.user_portfolios
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  ) OR EXISTS (
    SELECT 1 FROM public.user_positions
    WHERE portfolio_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  ) OR EXISTS (
    SELECT 1 FROM public.user_portfolio_snapshots
    WHERE portfolio_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  ) THEN
    RAISE EXCEPTION 'owner removal did not cascade atomically';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_portfolios
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
  ) THEN
    RAISE EXCEPTION 'cross-owner row was modified';
  END IF;
END
$post_delete$;
SQL

echo "legacy portfolio V1 retirement PostgreSQL 17 proof passed"
