#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803100500_atomic_ranking_snapshot_create.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/atomic-ranking-snapshot-pg17.XXXXXX)"
PG_DATA="$TMP_ROOT/data"
PG_SOCKET="$TMP_ROOT/socket"
PG_PORT="$((43000 + RANDOM % 14000))"

cleanup() {
  "$PG_BIN/pg_ctl" -D "$PG_DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

if [[ ! -x "$PG_BIN/postgres" ]] || ! "$PG_BIN/postgres" --version | grep -q 'PostgreSQL) 17\.'; then
  echo "PostgreSQL 17 is required; set PG17_BIN to its bin directory" >&2
  exit 1
fi

mkdir -p "$PG_SOCKET"
"$PG_BIN/initdb" -D "$PG_DATA" -A trust -U postgres >/dev/null
if ! "$PG_BIN/pg_ctl" -D "$PG_DATA" \
  -l "$TMP_ROOT/postgres.log" \
  -o "-F -p $PG_PORT -k $PG_SOCKET -c listen_addresses=''" \
  -w start >/dev/null; then
  cat "$TMP_ROOT/postgres.log" >&2
  exit 1
fi

psql_cmd() {
  "$PG_BIN/psql" \
    -X \
    -v ON_ERROR_STOP=1 \
    -h "$PG_SOCKET" \
    -p "$PG_PORT" \
    -U postgres \
    -d postgres \
    "$@"
}

TRADERS='[
  {
    "rank": 1,
    "trader_id": "alpha-id",
    "handle": "alpha",
    "source": "binance_futures",
    "avatar_url": "https://cdn.example/alpha.png",
    "roi": 42.5,
    "pnl": 1000,
    "win_rate": 55.5,
    "max_drawdown": 8,
    "trades_count": 20,
    "followers": 100,
    "arena_score": 88,
    "return_score": 90,
    "drawdown_score": 70,
    "stability_score": 75,
    "data_availability": {"roi": true, "pnl": true}
  },
  {
    "rank": 2,
    "trader_id": "beta-id",
    "handle": "beta",
    "source": "bybit_futures",
    "avatar_url": null,
    "roi": 12,
    "pnl": null,
    "win_rate": null,
    "max_drawdown": null,
    "trades_count": null,
    "followers": 2,
    "arena_score": 60,
    "return_score": null,
    "drawdown_score": null,
    "stability_score": null,
    "data_availability": null
  }
]'

psql_cmd >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE rogue_snapshot_writer NOLOGIN;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id)
);

CREATE TABLE public.ranking_snapshots (
  id uuid DEFAULT pg_catalog.gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT pg_catalog.now() NOT NULL,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  time_range text NOT NULL CHECK (time_range IN ('7D', '30D', '90D')),
  exchange text,
  category text,
  total_traders integer NOT NULL DEFAULT 0,
  top_trader_handle text,
  top_trader_roi numeric,
  data_captured_at timestamptz NOT NULL,
  data_delay_minutes integer DEFAULT 15,
  share_token text UNIQUE,
  is_public boolean DEFAULT true,
  view_count integer DEFAULT 0,
  expires_at timestamptz,
  is_expired boolean DEFAULT false,
  title text,
  description text
);

CREATE TABLE public.snapshot_traders (
  id uuid DEFAULT pg_catalog.gen_random_uuid() PRIMARY KEY,
  snapshot_id uuid NOT NULL
    REFERENCES public.ranking_snapshots(id) ON DELETE CASCADE,
  rank integer NOT NULL,
  trader_id text NOT NULL,
  handle text,
  source text NOT NULL,
  avatar_url text,
  roi numeric,
  pnl numeric,
  win_rate numeric,
  max_drawdown numeric,
  trades_count integer,
  followers integer,
  arena_score numeric,
  return_score numeric,
  drawdown_score numeric,
  stability_score numeric,
  data_availability jsonb,
  CONSTRAINT unique_snapshot_rank UNIQUE (snapshot_id, rank)
);

ALTER TABLE public.ranking_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.snapshot_traders ENABLE ROW LEVEL SECURITY;
CREATE POLICY browser_snapshot_insert
  ON public.ranking_snapshots FOR INSERT TO authenticated
  WITH CHECK (created_by = NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid);
CREATE POLICY browser_snapshot_child_insert
  ON public.snapshot_traders FOR INSERT TO authenticated
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ranking_snapshots
  TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.snapshot_traders
  TO authenticated, service_role;
GRANT UPDATE (title) ON public.ranking_snapshots TO PUBLIC;

INSERT INTO auth.users (id)
VALUES ('10000000-0000-4000-8000-000000000001');
INSERT INTO public.user_profiles (id)
VALUES ('10000000-0000-4000-8000-000000000001');
SQL

psql_cmd <"$MIGRATION" >/dev/null

# exact complete snapshot publication
psql_cmd -v traders="$TRADERS" >/dev/null <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT pg_catalog.set_config('test.snapshot_traders', :'traders', false);
DO $exact_snapshot_create$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.create_ranking_snapshot_atomic(
    '10000000-0000-4000-8000-000000000001',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'all',
    '90D',
    pg_catalog.current_setting('test.snapshot_traders')::jsonb
  );
  IF v_result ->> 'status' <> 'created'
     OR v_result -> 'applied' <> 'true'::jsonb
     OR v_result ->> 'operation' <> 'create_snapshot'
     OR v_result ->> 'actor_id' <> '10000000-0000-4000-8000-000000000001'
     OR v_result ->> 'request_id' <> 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
     OR v_result #>> '{snapshot,created_by}' <>
       '10000000-0000-4000-8000-000000000001'
     OR v_result #>> '{snapshot,total_traders}' <> '2'
     OR v_result #>> '{snapshot,top_trader_handle}' <> 'alpha'
     OR v_result #>> '{snapshot,top_trader_roi}' <> '42.5'
  THEN
    RAISE EXCEPTION 'exact complete snapshot acknowledgement failed: %', v_result;
  END IF;
END
$exact_snapshot_create$;
RESET ROLE;
SQL

psql_cmd >/dev/null <<'SQL'
DO $persisted_snapshot_truth$
DECLARE
  v_snapshot public.ranking_snapshots%ROWTYPE;
  v_children integer;
BEGIN
  SELECT snapshot.*
  INTO STRICT v_snapshot
  FROM public.ranking_snapshots AS snapshot;
  SELECT pg_catalog.count(*)::integer
  INTO v_children
  FROM public.snapshot_traders AS trader
  WHERE trader.snapshot_id = v_snapshot.id;

  IF v_snapshot.created_by <> '10000000-0000-4000-8000-000000000001'
     OR v_snapshot.is_public IS DISTINCT FROM true
     OR v_snapshot.total_traders <> 2
     OR v_snapshot.top_trader_handle <> 'alpha'
     OR v_snapshot.top_trader_roi <> 42.5
     OR v_children <> 2
  THEN
    RAISE EXCEPTION 'persisted snapshot is incomplete: %, %', v_snapshot, v_children;
  END IF;
END
$persisted_snapshot_truth$;
SQL

# exact actor/request replay returns the original generated resource
first_snapshot_id="$(psql_cmd -Atqc "SELECT snapshot_id FROM public.ranking_snapshot_create_operation_results WHERE actor_id='10000000-0000-4000-8000-000000000001' AND request_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'")"
first_share_token="$(psql_cmd -Atqc "SELECT result #>> '{snapshot,share_token}' FROM public.ranking_snapshot_create_operation_results WHERE actor_id='10000000-0000-4000-8000-000000000001' AND request_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'")"
psql_cmd -v traders="$TRADERS" -v expected_id="$first_snapshot_id" -v expected_token="$first_share_token" >/dev/null <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT pg_catalog.set_config('test.snapshot_traders', :'traders', false);
SELECT pg_catalog.set_config('test.expected_snapshot_id', :'expected_id', false);
SELECT pg_catalog.set_config('test.expected_share_token', :'expected_token', false);
DO $exact_replay$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.create_ranking_snapshot_atomic(
    '10000000-0000-4000-8000-000000000001',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'all',
    '90D',
    pg_catalog.current_setting('test.snapshot_traders')::jsonb
  );
  IF v_result ->> 'status' <> 'replayed'
     OR v_result -> 'applied' <> 'false'::jsonb
     OR v_result #>> '{snapshot,id}' <>
       pg_catalog.current_setting('test.expected_snapshot_id')
     OR v_result #>> '{snapshot,share_token}' <>
       pg_catalog.current_setting('test.expected_share_token')
  THEN
    RAISE EXCEPTION 'exact snapshot replay failed: %', v_result;
  END IF;
END
$exact_replay$;
RESET ROLE;
SQL
psql_cmd -Atqc 'SELECT count(*) FROM public.ranking_snapshots' | grep -qx '1'
psql_cmd -Atqc 'SELECT count(*) FROM public.snapshot_traders' | grep -qx '2'

# same actor/request with another logical payload conflicts without publication
psql_cmd -v traders="$TRADERS" >/dev/null <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT pg_catalog.set_config('test.snapshot_traders', :'traders', false);
DO $conflicting_replay$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.create_ranking_snapshot_atomic(
    '10000000-0000-4000-8000-000000000001',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'binance_futures',
    '90D',
    pg_catalog.current_setting('test.snapshot_traders')::jsonb
  );
  IF v_result <> '{"status":"request_conflict"}'::jsonb THEN
    RAISE EXCEPTION 'changed snapshot replay did not conflict: %', v_result;
  END IF;
END
$conflicting_replay$;
RESET ROLE;
SQL
psql_cmd -Atqc 'SELECT count(*) FROM public.ranking_snapshots' | grep -qx '1'

# any child failure rolls back the private parent and replay receipt
psql_cmd >/dev/null <<'SQL'
CREATE FUNCTION public.fail_test_snapshot_child()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF pg_catalog.current_setting('test.fail_snapshot_child', true) = 'on'
     AND NEW.rank = 2
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'injected snapshot child failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_fail_test_snapshot_child
BEFORE INSERT ON public.snapshot_traders
FOR EACH ROW EXECUTE FUNCTION public.fail_test_snapshot_child();
SQL

psql_cmd -v traders="$TRADERS" >/dev/null <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT pg_catalog.set_config('test.fail_snapshot_child', 'on', false);
SELECT pg_catalog.set_config('test.snapshot_traders', :'traders', false);
DO $child_failure_rollback$
BEGIN
  BEGIN
    PERFORM public.create_ranking_snapshot_atomic(
      '10000000-0000-4000-8000-000000000001',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'all',
      '30D',
      pg_catalog.current_setting('test.snapshot_traders')::jsonb
    );
    RAISE EXCEPTION 'injected child failure was not raised';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM <> 'injected snapshot child failure' THEN
        RAISE;
      END IF;
  END;
END
$child_failure_rollback$;
RESET ROLE;
SQL
psql_cmd -Atqc 'SELECT count(*) FROM public.ranking_snapshots' | grep -qx '1'
psql_cmd -Atqc "SELECT count(*) FROM public.ranking_snapshot_create_operation_results WHERE request_id='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'" | grep -qx '0'
psql_cmd -c 'DROP TRIGGER trg_fail_test_snapshot_child ON public.snapshot_traders; DROP FUNCTION public.fail_test_snapshot_child();' >/dev/null

# concurrent identical retries serialize to one resource and one replay
psql_cmd -Atq -v traders="$TRADERS" >"$TMP_ROOT/concurrent-a.log" 2>&1 <<'SQL' &
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.create_ranking_snapshot_atomic(
  '10000000-0000-4000-8000-000000000001',
  'cccccccccccccccccccccccccccccccc',
  'all',
  '7D',
  :'traders'::jsonb
) ->> 'status';
SQL
concurrent_a_pid=$!
psql_cmd -Atq -v traders="$TRADERS" >"$TMP_ROOT/concurrent-b.log" 2>&1 <<'SQL' &
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.create_ranking_snapshot_atomic(
  '10000000-0000-4000-8000-000000000001',
  'cccccccccccccccccccccccccccccccc',
  'all',
  '7D',
  :'traders'::jsonb
) ->> 'status';
SQL
concurrent_b_pid=$!
wait "$concurrent_a_pid"
wait "$concurrent_b_pid"
cat "$TMP_ROOT/concurrent-a.log" "$TMP_ROOT/concurrent-b.log" | grep -Ec '^(created|replayed)$' | grep -qx '2'
cat "$TMP_ROOT/concurrent-a.log" "$TMP_ROOT/concurrent-b.log" | grep -c '^created$' | grep -qx '1'
cat "$TMP_ROOT/concurrent-a.log" "$TMP_ROOT/concurrent-b.log" | grep -c '^replayed$' | grep -qx '1'
psql_cmd -Atqc "SELECT count(*) FROM public.ranking_snapshot_create_operation_results WHERE request_id='cccccccccccccccccccccccccccccccc'" | grep -qx '1'
psql_cmd -Atqc 'SELECT count(*) FROM public.ranking_snapshots' | grep -qx '2'
psql_cmd -Atqc 'SELECT count(*) FROM public.snapshot_traders' | grep -qx '4'

# service-only RPC, private ledger and browser write closure
psql_cmd >/dev/null <<'SQL'
DO $acl_contract$
DECLARE
  v_function regprocedure :=
    'public.create_ranking_snapshot_atomic(uuid,text,text,text,jsonb)'::regprocedure;
BEGIN
  IF NOT pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticator', v_function, 'EXECUTE')
     OR pg_catalog.has_table_privilege(
       'service_role',
       'public.ranking_snapshot_create_operation_results',
       'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated',
       'public.ranking_snapshots',
       'INSERT,UPDATE,DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated',
       'public.snapshot_traders',
       'INSERT,UPDATE,DELETE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role',
       'public.ranking_snapshots',
       'INSERT'
     )
  THEN
    RAISE EXCEPTION 'atomic ranking snapshot ACL contract drifted';
  END IF;
END
$acl_contract$;
SQL

# replay converges rogue grants without changing published resources
snapshot_digest="$(psql_cmd -Atqc "SELECT pg_catalog.md5(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(snapshot) ORDER BY snapshot.id)::text) FROM public.ranking_snapshots AS snapshot")"
trader_digest="$(psql_cmd -Atqc "SELECT pg_catalog.md5(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(trader) ORDER BY trader.snapshot_id, trader.rank)::text) FROM public.snapshot_traders AS trader")"
psql_cmd -c 'GRANT EXECUTE ON FUNCTION public.create_ranking_snapshot_atomic(uuid,text,text,text,jsonb) TO rogue_snapshot_writer; GRANT SELECT ON public.ranking_snapshot_create_operation_results TO rogue_snapshot_writer; GRANT UPDATE (title) ON public.ranking_snapshots TO authenticated;' >/dev/null
psql_cmd <"$MIGRATION" >/dev/null
[[ "$snapshot_digest" == "$(psql_cmd -Atqc "SELECT pg_catalog.md5(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(snapshot) ORDER BY snapshot.id)::text) FROM public.ranking_snapshots AS snapshot")" ]]
[[ "$trader_digest" == "$(psql_cmd -Atqc "SELECT pg_catalog.md5(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(trader) ORDER BY trader.snapshot_id, trader.rank)::text) FROM public.snapshot_traders AS trader")" ]]
psql_cmd -Atqc "SELECT pg_catalog.has_function_privilege('rogue_snapshot_writer','public.create_ranking_snapshot_atomic(uuid,text,text,text,jsonb)','EXECUTE')" | grep -qx 'f'
psql_cmd -Atqc "SELECT pg_catalog.has_table_privilege('rogue_snapshot_writer','public.ranking_snapshot_create_operation_results','SELECT')" | grep -qx 'f'
psql_cmd -Atqc "SELECT pg_catalog.has_column_privilege('authenticated','public.ranking_snapshots','title','UPDATE')" | grep -qx 'f'

echo 'atomic ranking snapshot PostgreSQL 17 atomic/replay/ACL proof passed'
