#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for 20261123021904_public_ranked_leaderboard_window_flags:
# public.public_ranked_leaderboard gains two trailing boolean columns,
# idle_window and mdd_contradiction, read from leaderboard_ranks.score_factors.
#
#   1. The fixture creates the view from the migration that last defined it
#      (20260816184500) and checks that its pg_get_viewdef digest is the one
#      exported read-only from production.
#   2. The migration runs as a NOSUPERUSER postgres role (as on Supabase).
#   3. Marked rows read true; unmarked rows, NULL score_factors and every
#      malformed value read false; no value makes the view raise.
#   4. The 35 existing columns and the row set are unchanged; options, owner,
#      ACL and comment are unchanged; dependents keep working without being
#      recreated.
#   5. Replay changes nothing.
#   6. Drift (definition, options, owner, missing view) makes the whole
#      migration refuse and leaves the view as it was.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
MIGRATION="$MIGRATIONS/20261123021904_public_ranked_leaderboard_window_flags.sql"
BASELINE="$MIGRATIONS/20260816184500_public_ranked_leaderboard_source_freshness_gate.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

PRODUCTION_VIEW_SHA256='e7a040df0d437b2885ccad4f31108b260999f8421dd10c737466a756e3b6d0a7'
NEW_VIEW_SHA256='452bf1c819abc3b8b5f94405fc9168782dfca445cd6430e8474498b900641140'

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

TMP_ROOT="$(mktemp -d /tmp/ranked-view-flags-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 8000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -60 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

DB=postgres
psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d "$DB" "$@"
}
psql_admin() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U supabase_admin -d postgres "$@"
}

expect_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label drifted:" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

# The digest the migration computes: public visible, arena not.
view_sha256() {
  psql_cmd -Atqc "
    SET search_path = public, pg_temp;
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.pg_get_viewdef('public.public_ranked_leaderboard'::pg_catalog.regclass, true),
      'UTF8')), 'hex');
  " | tail -1
}

# Everything but the column list.
view_attributes() {
  psql_cmd -Atqc "
    SELECT pg_catalog.concat_ws('|',
      class_row.oid::pg_catalog.text,
      class_row.relkind,
      pg_catalog.pg_get_userbyid(class_row.relowner),
      class_row.reloptions::pg_catalog.text,
      class_row.relacl::pg_catalog.text,
      pg_catalog.obj_description(class_row.oid, 'pg_class'))
    FROM pg_catalog.pg_class AS class_row
    WHERE class_row.oid = 'public.public_ranked_leaderboard'::pg_catalog.regclass;
  "
}

view_columns() {
  psql_cmd -Atqc "
    SELECT pg_catalog.string_agg(
      attname || ':' || pg_catalog.format_type(atttypid, atttypmod), ',' ORDER BY attnum)
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.public_ranked_leaderboard'::pg_catalog.regclass
      AND attnum > 0 AND NOT attisdropped;
  "
}

# The 35 original columns of every served row, as one digest.
original_columns_digest() {
  psql_cmd -Atqc "
    SELECT pg_catalog.md5(pg_catalog.string_agg(
      (pg_catalog.to_jsonb(ranked) - 'idle_window' - 'mdd_contradiction')::pg_catalog.text,
      E'\n' ORDER BY ranked.id))
      || '|' || pg_catalog.count(*)
    FROM public.public_ranked_leaderboard AS ranked;
  "
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U supabase_admin --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

# Like Supabase: the cluster superuser is supabase_admin; every fixture object
# and the migration run as a NOSUPERUSER postgres role.
psql_admin -q <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE NOBYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER;
CREATE ROLE service_role NOLOGIN NOSUPERUSER;
CREATE ROLE other_owner NOLOGIN NOSUPERUSER;
GRANT anon, authenticated, service_role, other_owner TO postgres;
GRANT CREATE ON DATABASE postgres TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL
if [[ "$(psql_cmd -Atqc "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user")" != "f" ]]; then
  echo "migrations must run as a non-superuser postgres role" >&2
  exit 1
fi

# The relations and functions the view reads, with the production column
# types of the 35 projected columns (20261111140053). The season authority and
# the row policy are stand-ins: this proof is about the projection.
psql_cmd -q <<'SQL'
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role, other_owner;
GRANT CREATE ON SCHEMA public TO other_owner;

CREATE TABLE public.leaderboard_ranks (
  id bigint NOT NULL,
  season_id text NOT NULL,
  source text NOT NULL,
  source_type text,
  source_trader_id text NOT NULL,
  rank integer,
  arena_score numeric(10, 2),
  arena_score_v3 numeric,
  arena_score_v4 numeric,
  roi numeric(12, 4),
  pnl numeric(18, 2),
  win_rate numeric(5, 2),
  max_drawdown numeric(5, 2),
  followers integer,
  copiers integer,
  trades_count integer,
  handle text,
  avatar_url text,
  computed_at timestamptz,
  profitability_score numeric(6, 2),
  risk_control_score numeric(6, 2),
  execution_score numeric(6, 2),
  score_completeness text,
  trading_style text,
  avg_holding_hours numeric(10, 2),
  style_confidence numeric(6, 4),
  sharpe_ratio numeric(10, 4),
  sortino_ratio numeric(10, 4),
  profit_factor numeric(10, 4),
  calmar_ratio numeric(10, 4),
  trader_type text,
  is_outlier boolean,
  metrics_estimated boolean,
  rank_change integer,
  is_new boolean,
  score_factors jsonb,
  rank_publication_id uuid,
  PRIMARY KEY (id, season_id)
);

CREATE TABLE arena.public_ranked_leaderboard_serving_heads (
  season_id text PRIMARY KEY,
  score_cohort_id uuid NOT NULL
);
CREATE TABLE arena.public_ranked_leaderboard_serving_sources (
  season_id text NOT NULL,
  source text NOT NULL,
  score_cohort_id uuid NOT NULL,
  PRIMARY KEY (season_id, source)
);

CREATE FUNCTION arena.public_ranked_leaderboard_serving_seasons(p_observed_at timestamptz)
RETURNS TABLE (season_id text)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT head.season_id FROM arena.public_ranked_leaderboard_serving_heads AS head;
$function$;
REVOKE ALL ON FUNCTION arena.public_ranked_leaderboard_serving_seasons(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION arena.public_ranked_leaderboard_serving_seasons(timestamptz)
  TO anon, authenticated, service_role;

CREATE FUNCTION arena.public_ranked_leaderboard_row_is_eligible(
  p_rank public.leaderboard_ranks,
  p_observed_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE((p_rank).arena_score > 0 AND (p_rank).arena_score <= 100, false);
$function$;
REVOKE ALL ON FUNCTION arena.public_ranked_leaderboard_row_is_eligible(
  public.leaderboard_ranks, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION arena.public_ranked_leaderboard_row_is_eligible(
  public.leaderboard_ranks, timestamptz) TO anon, authenticated, service_role;
SQL

# 1. The view exactly as 20260816184500 defines it, with the 20260816151614
#    owner, grants and the 20260816184500 comment.
awk '
  /^CREATE OR REPLACE VIEW public\.public_ranked_leaderboard$/ { printing = 1 }
  printing { print }
  printing && /^  \);$/ { exit }
' "$BASELINE" >"$TMP_ROOT/baseline-view.sql"
if ! grep -q 'arena.public_ranked_leaderboard_row_is_eligible(' "$TMP_ROOT/baseline-view.sql"; then
  echo "could not extract the production view definition from $BASELINE" >&2
  exit 1
fi
psql_cmd -q -f "$TMP_ROOT/baseline-view.sql"
psql_cmd -q <<'SQL'
ALTER VIEW public.public_ranked_leaderboard OWNER TO postgres;
REVOKE ALL ON TABLE public.public_ranked_leaderboard
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.public_ranked_leaderboard
  TO anon, authenticated, service_role;
COMMENT ON VIEW public.public_ranked_leaderboard IS
  'Only current, globally sealed, source-fresh, full/non-estimated public leaderboard rows. Any expected-source, freshness, cohort, or rank-mutation drift hides the entire affected season.';
SQL
expect_eq "the repository definition is the production definition" \
  "$(view_sha256)" "$PRODUCTION_VIEW_SHA256"
expect_eq "production options" \
  "$(psql_cmd -Atqc "SELECT reloptions::text FROM pg_catalog.pg_class WHERE oid = 'public.public_ranked_leaderboard'::regclass")" \
  "{security_barrier=true,security_invoker=false}"
expect_eq "production ACL" \
  "$(psql_cmd -Atqc "SELECT relacl::text FROM pg_catalog.pg_class WHERE oid = 'public.public_ranked_leaderboard'::regclass")" \
  "{postgres=arwdDxtm/postgres,anon=r/postgres,authenticated=r/postgres,service_role=r/postgres}"
COLUMNS_BEFORE="$(view_columns)"
expect_eq "production column list" "$COLUMNS_BEFORE" \
  "id:bigint,season_id:text,source:text,source_type:text,source_trader_id:text,rank:integer,arena_score:numeric(10,2),arena_score_v3:numeric,arena_score_v4:numeric,roi:numeric(12,4),pnl:numeric(18,2),win_rate:numeric(5,2),max_drawdown:numeric(5,2),followers:integer,copiers:integer,trades_count:integer,handle:text,avatar_url:text,computed_at:timestamp with time zone,profitability_score:numeric(6,2),risk_control_score:numeric(6,2),execution_score:numeric(6,2),score_completeness:text,trading_style:text,avg_holding_hours:numeric(10,2),style_confidence:numeric(6,4),sharpe_ratio:numeric(10,4),sortino_ratio:numeric(10,4),profit_factor:numeric(10,4),calmar_ratio:numeric(10,4),trader_type:text,is_outlier:boolean,metrics_estimated:boolean,rank_change:integer,is_new:boolean"

# Served rows: one season head, two sources. score_factors covers every shape.
psql_cmd -q <<'SQL'
INSERT INTO arena.public_ranked_leaderboard_serving_heads VALUES
  ('7D', '00000000-0000-4000-8000-000000000001');
INSERT INTO arena.public_ranked_leaderboard_serving_sources VALUES
  ('7D', 'bybit', '00000000-0000-4000-8000-000000000001'),
  ('7D', 'xt', '00000000-0000-4000-8000-000000000001');

INSERT INTO public.leaderboard_ranks (
  id, season_id, source, source_type, source_trader_id, rank, arena_score, roi, pnl,
  win_rate, max_drawdown, score_completeness, is_outlier, metrics_estimated, is_new,
  computed_at, score_factors, rank_publication_id
)
SELECT
  fixture.id, '7D', fixture.source, 'futures', fixture.trader, fixture.id::integer,
  fixture.score, fixture.roi, fixture.pnl, fixture.win_rate, fixture.max_drawdown,
  fixture.completeness, false, false, false, pg_catalog.now(), fixture.factors::jsonb,
  '00000000-0000-4000-8000-000000000001'
FROM (VALUES
  -- a scored row: no mark
  (1,  'bybit', 'scored',            88.10, 40,  9000, 61, 8,    'full',
   '{"roi":0.9,"pnl":0.5,"drawdown":0.7,"sharpe":null,"consistency":0.6}'),
  -- a losing window whose 0% drawdown was refused
  (2,  'bybit', 'contradiction',     12.40, -12, -900, 55, NULL, 'partial',
   '{"roi":0.1,"pnl":0,"drawdown":null,"sharpe":null,"consistency":0.5,"mdd_contradiction":true}'),
  -- idle rows, with and without their own metrics
  (3,  'bybit', 'idle-zero-dd',      0.01,  0,   0,    0,  0,    'full',
   '{"roi":0,"pnl":0,"drawdown":null,"sharpe":null,"consistency":null,"idle_window":true}'),
  (4,  'xt',    'idle-bare',         0.01,  0,   0,    NULL, NULL, 'minimal',
   '{"roi":0,"pnl":0,"drawdown":null,"sharpe":null,"consistency":null,"idle_window":true}'),
  -- explicit false, and both keys
  (5,  'xt',    'explicit-false',    30.00, 5,   100,  50, 10,   'full',
   '{"idle_window":false,"mdd_contradiction":false}'),
  (6,  'xt',    'both-true',         0.50,  1,   1,    50, 10,   'full',
   '{"idle_window":true,"mdd_contradiction":true}'),
  -- no score_factors at all (every row published before the rule)
  (7,  'bybit', 'factors-sql-null',  70.00, 20,  500,  50, 10,   'full', NULL),
  -- malformed: none of these is the JSON boolean true, none may raise
  (8,  'bybit', 'factors-json-null', 60.00, 20,  500,  50, 10,   'full', 'null'),
  (9,  'bybit', 'factors-array',     59.00, 20,  500,  50, 10,   'full', '["idle_window"]'),
  (10, 'bybit', 'factors-string',    58.00, 20,  500,  50, 10,   'full', '"idle_window"'),
  (11, 'bybit', 'factors-number',    57.00, 20,  500,  50, 10,   'full', '1'),
  (12, 'bybit', 'value-string-true', 56.00, 20,  500,  50, 10,   'full',
   '{"idle_window":"true","mdd_contradiction":"true"}'),
  (13, 'bybit', 'value-not-boolean', 55.00, 20,  500,  50, 10,   'full',
   '{"idle_window":"abc","mdd_contradiction":{"nested":true}}'),
  (14, 'bybit', 'value-number',      54.00, 20,  500,  50, 10,   'full',
   '{"idle_window":1,"mdd_contradiction":0}'),
  (15, 'bybit', 'value-null',        53.00, 20,  500,  50, 10,   'full',
   '{"idle_window":null,"mdd_contradiction":null}'),
  (16, 'bybit', 'value-array',       52.00, 20,  500,  50, 10,   'full',
   '{"idle_window":[true],"mdd_contradiction":[]}'),
  -- not served: the row policy refuses it (score 0)
  (17, 'bybit', 'not-eligible',      0.00,  1,   1,    50, 10,   'full',
   '{"idle_window":true}')
) AS fixture(id, source, trader, score, roi, pnl, win_rate, max_drawdown, completeness, factors);

-- Not served: no rank, another cohort, a source without a witness.
INSERT INTO public.leaderboard_ranks (
  id, season_id, source, source_trader_id, rank, arena_score, score_factors, rank_publication_id
) VALUES
  (18, '7D', 'bybit', 'no-rank', NULL, 50, '{"idle_window":true}',
   '00000000-0000-4000-8000-000000000001'),
  (19, '7D', 'bybit', 'other-cohort', 19, 50, '{"idle_window":true}',
   '00000000-0000-4000-8000-000000000002'),
  (20, '7D', 'gateio', 'no-witness', 20, 50, '{"idle_window":true}',
   '00000000-0000-4000-8000-000000000001'),
  (21, '30D', 'bybit', 'season-not-served', 21, 50, '{"idle_window":true}',
   '00000000-0000-4000-8000-000000000001');

-- Dependents that read the view the way the application does: named columns,
-- and a whole-row read.
CREATE FUNCTION public.fixture_hero_stats()
RETURNS TABLE (exchange_count bigint, trader_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.count(DISTINCT ranked.source), pg_catalog.count(*)
  FROM public.public_ranked_leaderboard AS ranked;
$function$;

CREATE FUNCTION public.fixture_top_trader()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT ranked.source_trader_id
  FROM public.public_ranked_leaderboard AS ranked
  ORDER BY ranked.rank
  LIMIT 1;
$function$;
SQL

SERVED_BEFORE="$(original_columns_digest)"
expect_eq "served row count before" "${SERVED_BEFORE##*|}" "16"
ATTRIBUTES_BEFORE="$(view_attributes)"
expect_eq "dependents before" \
  "$(psql_cmd -Atqc "SELECT exchange_count || '|' || trader_count || '|' || public.fixture_top_trader() FROM public.fixture_hero_stats()")" \
  "2|16|scored"

# Copies of this exact state for the drift cases (a view column cannot be
# removed without DROP, so each case gets its own database).
for drift_db in drift_definition drift_options drift_owner drift_missing; do
  psql_admin -q -c "CREATE DATABASE $drift_db TEMPLATE postgres OWNER postgres"
done

# 2. Apply as the non-superuser postgres role.
psql_cmd -q -f "$MIGRATION"
if [[ "$NEW_VIEW_SHA256" == __NEW_* ]]; then
  echo "definition digest after the migration: $(view_sha256)" >&2
  exit 1
fi
expect_eq "installed definition digest" "$(view_sha256)" "$NEW_VIEW_SHA256"

# 4. Nothing but the column list moved, and the two columns are appended.
expect_eq "options, owner, ACL and comment" "$(view_attributes)" "$ATTRIBUTES_BEFORE"
expect_eq "column list" "$(view_columns)" \
  "$COLUMNS_BEFORE,idle_window:boolean,mdd_contradiction:boolean"
expect_eq "the 35 original columns of every served row, and the row set" \
  "$(original_columns_digest)" "$SERVED_BEFORE"

# 3. Flags: true only for the JSON boolean true; never NULL; never an error.
expect_eq "flags per served row" \
  "$(psql_cmd -Atqc "
    SELECT pg_catalog.string_agg(
      source_trader_id || '=' || idle_window::int || mdd_contradiction::int, ',' ORDER BY id)
    FROM public.public_ranked_leaderboard")" \
  "scored=00,contradiction=01,idle-zero-dd=10,idle-bare=10,explicit-false=00,both-true=11,factors-sql-null=00,factors-json-null=00,factors-array=00,factors-string=00,factors-number=00,value-string-true=00,value-not-boolean=00,value-number=00,value-null=00,value-array=00"
expect_eq "the flags are never NULL" \
  "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.public_ranked_leaderboard WHERE idle_window IS NULL OR mdd_contradiction IS NULL")" \
  "0"
# What the UI contract says about the marked rows.
expect_eq "an idle row keeps its own metrics and label; a refused drawdown is NULL" \
  "$(psql_cmd -Atqc "
    SELECT pg_catalog.string_agg(pg_catalog.concat_ws(':', source_trader_id, arena_score,
             COALESCE(win_rate::text, 'null'), COALESCE(max_drawdown::text, 'null'),
             score_completeness), ',' ORDER BY id)
    FROM public.public_ranked_leaderboard
    WHERE idle_window OR mdd_contradiction")" \
  "contradiction:12.40:55.00:null:partial,idle-zero-dd:0.01:0.00:0.00:full,idle-bare:0.01:null:null:minimal,both-true:0.50:50.00:10.00:full"
# A filter on the new columns works for the API roles.
expect_eq "anon filters on the flags" \
  "$(psql_cmd -Atqc "SET ROLE anon; SELECT pg_catalog.count(*) FILTER (WHERE idle_window) || '|' || pg_catalog.count(*) FILTER (WHERE mdd_contradiction) || '|' || pg_catalog.count(*) FROM public.public_ranked_leaderboard" | tail -1)" \
  "3|2|16"
expect_eq "privileges" \
  "$(psql_cmd -Atqc "
    SELECT pg_catalog.concat_ws('|',
      pg_catalog.has_table_privilege('anon', 'public.public_ranked_leaderboard', 'SELECT'),
      pg_catalog.has_table_privilege('authenticated', 'public.public_ranked_leaderboard', 'SELECT'),
      pg_catalog.has_table_privilege('service_role', 'public.public_ranked_leaderboard', 'SELECT'),
      pg_catalog.has_table_privilege('anon', 'public.public_ranked_leaderboard', 'INSERT'),
      pg_catalog.has_table_privilege('anon', 'public.leaderboard_ranks', 'SELECT'),
      pg_catalog.has_column_privilege('anon', 'public.public_ranked_leaderboard', 'idle_window', 'SELECT'))")" \
  "t|t|t|f|f|t"
# The underlying score_factors column is still not reachable through the view.
if psql_cmd -Atqc "SET ROLE anon; SELECT score_factors FROM public.public_ranked_leaderboard" >/dev/null 2>&1; then
  echo "score_factors became readable through the public view" >&2
  exit 1
fi

# Dependents keep working, unchanged, without being recreated.
expect_eq "dependents after" \
  "$(psql_cmd -Atqc "SELECT exchange_count || '|' || trader_count || '|' || public.fixture_top_trader() FROM public.fixture_hero_stats()")" \
  "2|16|scored"

# While the worker publishes with the old rule no row carries a mark: both
# columns are false on every row.
psql_cmd -q -c "UPDATE public.leaderboard_ranks SET score_factors = '{\"roi\":0.5,\"pnl\":0.5,\"drawdown\":0.5,\"sharpe\":null,\"consistency\":0.5}'"
expect_eq "old-rule rows: both flags false everywhere" \
  "$(psql_cmd -Atqc "SELECT pg_catalog.bool_or(idle_window) || '|' || pg_catalog.bool_or(mdd_contradiction) || '|' || pg_catalog.count(*) FROM public.public_ranked_leaderboard")" \
  "false|false|16"

# 5. Replay: accepted, and nothing changes.
psql_cmd -q -f "$MIGRATION"
expect_eq "replay definition digest" "$(view_sha256)" "$NEW_VIEW_SHA256"
expect_eq "replay attributes" "$(view_attributes)" "$ATTRIBUTES_BEFORE"
expect_eq "replay column list" "$(view_columns)" \
  "$COLUMNS_BEFORE,idle_window:boolean,mdd_contradiction:boolean"

# 6. Drift: each case must make the migration refuse and change nothing.
refuses() {
  local label="$1" expected_message="$2" output digest_before columns_before
  digest_before="$(view_sha256 2>/dev/null || echo missing)"
  columns_before="$(view_columns 2>/dev/null || echo missing)"
  if output="$(psql_cmd -q -f "$MIGRATION" 2>&1)"; then
    echo "$label: the migration ran against a drifted view" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected_message"* ]]; then
    echo "$label: refused for an unexpected reason:" >&2
    echo "$output" >&2
    exit 1
  fi
  expect_eq "$label left the definition alone" "$(view_sha256 2>/dev/null || echo missing)" "$digest_before"
  expect_eq "$label left the columns alone" "$(view_columns 2>/dev/null || echo missing)" "$columns_before"
}

# 6a. An unreviewed definition (one predicate differs).
DB=drift_definition
sed 's/WHERE rank_row.rank IS NOT NULL/WHERE rank_row.rank IS NOT NULL AND rank_row.rank < 1000000/' \
  "$TMP_ROOT/baseline-view.sql" >"$TMP_ROOT/drifted-view.sql"
psql_cmd -q -f "$TMP_ROOT/drifted-view.sql"
if [[ "$(view_sha256)" == "$PRODUCTION_VIEW_SHA256" ]]; then
  echo "the drift fixture did not change the definition" >&2
  exit 1
fi
refuses "unreviewed definition" "unexpected definition of public.public_ranked_leaderboard"

# 6b. Options.
DB=drift_options
psql_cmd -q -c "ALTER VIEW public.public_ranked_leaderboard SET (security_invoker = true)"
refuses "security_invoker turned on" "unexpected attributes"
psql_cmd -q -c "ALTER VIEW public.public_ranked_leaderboard SET (security_invoker = false)"
psql_cmd -q -c "ALTER VIEW public.public_ranked_leaderboard RESET (security_barrier)"
refuses "security_barrier removed" "unexpected attributes"

# 6c. Owner.
DB=drift_owner
psql_cmd -q -c "ALTER VIEW public.public_ranked_leaderboard OWNER TO other_owner"
refuses "another owner" "unexpected attributes"

# 6d. The view is missing.
DB=drift_missing
psql_cmd -q -c "ALTER VIEW public.public_ranked_leaderboard RENAME TO public_ranked_leaderboard_moved"
if output="$(psql_cmd -q -f "$MIGRATION" 2>&1)"; then
  echo "missing view: the migration created a view" >&2
  exit 1
fi
if [[ "$output" != *"does not exist"* ]]; then
  echo "missing view: refused for an unexpected reason:" >&2
  echo "$output" >&2
  exit 1
fi
expect_eq "missing view: nothing was created" \
  "$(psql_cmd -Atqc "SELECT pg_catalog.to_regclass('public.public_ranked_leaderboard') IS NULL")" "t"

echo "public ranked leaderboard window flags PostgreSQL 17 proof passed"
