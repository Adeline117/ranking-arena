#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729183000_atomic_trader_alert_mutation.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/atomic-trader-alert-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="$((55000 + ($$ % 800)))"

cleanup() {
  if [[ -d "$PGDATA" ]]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

if [[ ! -x "$PG_BIN/initdb" || ! -x "$PG_BIN/pg_ctl" || ! -x "$PG_BIN/psql" ]]; then
  echo "PostgreSQL 17 binaries not found at $PG_BIN" >&2
  exit 1
fi

mkdir -p "$SOCKET_DIR"
"$PG_BIN/initdb" -D "$PGDATA" --auth=trust --username=postgres --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$PGDATA" -o "-F -k $SOCKET_DIR -p $PORT" -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -q -h "$SOCKET_DIR" -p "$PORT" -U postgres postgres "$@"
}

psql_cmd <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  deleted_at timestamptz,
  is_pro boolean NOT NULL DEFAULT false
);

CREATE TABLE public.trader_alerts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  trader_id text NOT NULL,
  source text,
  enabled boolean NOT NULL DEFAULT true,
  alert_roi_change boolean NOT NULL DEFAULT true,
  roi_change_threshold numeric NOT NULL DEFAULT 10,
  alert_drawdown boolean NOT NULL DEFAULT true,
  drawdown_threshold numeric NOT NULL DEFAULT 20,
  alert_pnl_change boolean NOT NULL DEFAULT false,
  pnl_change_threshold numeric NOT NULL DEFAULT 5000,
  alert_score_change boolean NOT NULL DEFAULT true,
  score_change_threshold numeric NOT NULL DEFAULT 5,
  alert_rank_change boolean NOT NULL DEFAULT false,
  rank_change_threshold integer NOT NULL DEFAULT 5,
  one_time boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT trader_alerts_user_trader_source_key
    UNIQUE NULLS NOT DISTINCT (user_id, trader_id, source)
);

ALTER TABLE public.trader_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_trader_alerts ON public.trader_alerts
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trader_alerts TO authenticated;

CREATE OR REPLACE FUNCTION public.has_current_global_pro_entitlement(p_actor_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.id = p_actor_id
      AND profile.deleted_at IS NULL
      AND profile.is_pro
  )
$function$;
ALTER FUNCTION public.has_current_global_pro_entitlement(uuid) OWNER TO postgres;
SQL

psql_cmd -f "$MIGRATION"
psql_cmd -f "$MIGRATION"
echo 'migration replay'

ACTOR="11111111-1111-4111-8111-111111111111"
CAP_ACTOR="22222222-2222-4222-8222-222222222222"
FREE_ACTOR="33333333-3333-4333-8333-333333333333"

psql_cmd -v actor="$ACTOR" -v cap_actor="$CAP_ACTOR" -v free_actor="$FREE_ACTOR" <<'SQL'
INSERT INTO public.user_profiles (id, is_pro)
VALUES (:'actor', true), (:'cap_actor', true), (:'free_actor', false);
SQL

call_upsert() {
  local actor="$1"
  local trader_id="$2"
  local source="$3"
  local expected_alert_id="${4:-}"
  psql_cmd -At -v actor="$actor" -v trader_id="$trader_id" -v source="$source" \
    -v expected_alert_id="$expected_alert_id" <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', :'actor', false);
SELECT public.upsert_trader_alert_atomic(
  :'trader_id',
  :'source',
  NULLIF(:'expected_alert_id', '')::uuid,
  true,
  10,
  true,
  20,
  false,
  5000,
  true,
  5,
  false,
  5,
  false,
  true
);
SQL
}

call_delete_identity() {
  local actor="$1"
  local trader_id="$2"
  local source="$3"
  psql_cmd -At -v actor="$actor" -v trader_id="$trader_id" -v source="$source" <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', :'actor', false);
SELECT public.delete_trader_alert_atomic(NULL, :'trader_id', :'source');
SQL
}

created="$(call_upsert "$ACTOR" 'shared-trader' 'binance')"
updated="$(call_upsert "$ACTOR" 'shared-trader' 'binance')"
second_source="$(call_upsert "$ACTOR" 'shared-trader' 'bybit')"
grep -q '"status": "created"' <<<"$created"
grep -q '"status": "updated"' <<<"$updated"
grep -q '"status": "created"' <<<"$second_source"

stale_id="44444444-4444-4444-8444-444444444444"
conflict="$(call_upsert "$ACTOR" 'shared-trader' 'bybit' "$stale_id")"
grep -q '"status": "conflict"' <<<"$conflict"
echo 'stale alert id conflict'

deleted_source="$(call_delete_identity "$ACTOR" 'shared-trader' 'binance')"
grep -q '"status": "deleted"' <<<"$deleted_source"
remaining_sources="$(psql_cmd -At -c \
  "SELECT pg_catalog.string_agg(source, ',' ORDER BY source) FROM public.trader_alerts WHERE user_id = '$ACTOR'::uuid")"
[[ "$remaining_sources" == 'bybit' ]]
missing_source="$(call_delete_identity "$ACTOR" 'shared-trader' 'binance')"
grep -q '"status": "not_found"' <<<"$missing_source"
grep -q '"deleted_count": 0' <<<"$missing_source"
echo 'cross-source delete isolation'

forbidden="$(call_upsert "$FREE_ACTOR" 'free-trader' 'binance')"
grep -q '"status": "forbidden"' <<<"$forbidden"

psql_cmd -v cap_actor="$CAP_ACTOR" <<'SQL'
INSERT INTO public.trader_alerts (
  user_id,
  trader_id,
  source,
  alert_roi_change,
  roi_change_threshold,
  alert_drawdown,
  drawdown_threshold,
  alert_pnl_change,
  pnl_change_threshold,
  alert_score_change,
  score_change_threshold,
  alert_rank_change,
  rank_change_threshold,
  one_time,
  enabled
)
SELECT
  :'cap_actor',
  'seed-' || series_row::text,
  'seed',
  true,
  10,
  true,
  20,
  false,
  5000,
  true,
  5,
  false,
  5,
  false,
  true
FROM pg_catalog.generate_series(1, 49) AS series_row;
SQL

call_upsert "$CAP_ACTOR" 'race-a' 'binance' >"$TMP_ROOT/race-a.out" &
pid_a=$!
call_upsert "$CAP_ACTOR" 'race-b' 'bybit' >"$TMP_ROOT/race-b.out" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

race_output="$(cat "$TMP_ROOT/race-a.out" "$TMP_ROOT/race-b.out")"
[[ "$(grep -c '"status": "created"' <<<"$race_output")" == '1' ]]
[[ "$(grep -c '"status": "limit_reached"' <<<"$race_output")" == '1' ]]
cap_count="$(psql_cmd -At -c \
  "SELECT pg_catalog.count(*) FROM public.trader_alerts WHERE user_id = '$CAP_ACTOR'::uuid")"
[[ "$cap_count" == '50' ]]
echo 'concurrent 50-row capacity'

if psql_cmd -v actor="$ACTOR" >/dev/null 2>"$TMP_ROOT/direct-insert.err" <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', :'actor', false);
INSERT INTO public.trader_alerts (user_id, trader_id, source)
VALUES (:'actor', 'bypass', 'binance');
SQL
then
  echo 'authenticated direct insert unexpectedly succeeded' >&2
  exit 1
fi
grep -qi 'permission denied' "$TMP_ROOT/direct-insert.err"
echo 'authenticated direct insert revoked'

echo 'atomic trader alert mutation PostgreSQL 17 proof passed'
