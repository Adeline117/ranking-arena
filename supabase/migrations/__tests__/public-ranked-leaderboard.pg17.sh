#!/usr/bin/env bash

# PostgreSQL 17 behavior proof for the public ranked cohort view. It owns an
# isolated cluster and never connects to application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260816151614_public_ranked_leaderboard.sql"
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
  echo "Required migration not found: $MIGRATION" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/public-ranked-leaderboard-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -180 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_db() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "$label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

psql_db -q <<'SQL'
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE rogue_reader NOLOGIN NOBYPASSRLS;

CREATE SCHEMA arena AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, arena
  TO anon, authenticated, service_role, rogue_reader;

CREATE TABLE arena.exchanges (
  id bigint PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE arena.sources (
  slug text PRIMARY KEY,
  exchange_id bigint NOT NULL REFERENCES arena.exchanges(id),
  status text NOT NULL,
  serving_mode text NOT NULL,
  seasons text[] NOT NULL
);

CREATE TABLE public.leaderboard_ranks (
  id bigint NOT NULL,
  season_id text NOT NULL,
  source text NOT NULL,
  source_type text,
  source_trader_id text NOT NULL,
  rank integer,
  arena_score numeric,
  arena_score_v3 numeric,
  arena_score_v4 numeric,
  score_factors jsonb,
  roi numeric,
  pnl numeric,
  win_rate numeric,
  max_drawdown numeric,
  followers integer,
  copiers integer,
  trades_count integer,
  handle text,
  avatar_url text,
  computed_at timestamptz,
  profitability_score numeric,
  risk_control_score numeric,
  execution_score numeric,
  score_completeness text,
  trading_style text,
  avg_holding_hours numeric,
  style_confidence numeric,
  sharpe_ratio numeric,
  sortino_ratio numeric,
  profit_factor numeric,
  calmar_ratio numeric,
  trader_type text,
  is_outlier boolean,
  metrics_estimated boolean,
  rank_change integer,
  is_new boolean,
  PRIMARY KEY (id, season_id)
) PARTITION BY LIST (season_id);

CREATE TABLE public.leaderboard_ranks_7d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('7D');
CREATE TABLE public.leaderboard_ranks_30d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('30D');
CREATE TABLE public.leaderboard_ranks_default
  PARTITION OF public.leaderboard_ranks DEFAULT;

ALTER TABLE public.leaderboard_ranks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.leaderboard_ranks,
  public.leaderboard_ranks_7d,
  public.leaderboard_ranks_30d,
  public.leaderboard_ranks_default
  FROM PUBLIC, anon, authenticated, service_role, rogue_reader;
GRANT SELECT ON TABLE public.leaderboard_ranks,
  public.leaderboard_ranks_7d,
  public.leaderboard_ranks_30d,
  public.leaderboard_ranks_default TO anon, authenticated, service_role;

INSERT INTO arena.exchanges (id, name) VALUES (1, 'Fixture Exchange');
INSERT INTO arena.sources (slug, exchange_id, status, serving_mode, seasons)
VALUES
  ('active_source', 1, 'active', 'serving', ARRAY['7D']::text[]),
  ('inactive_source', 1, 'inactive', 'serving', ARRAY['7D']::text[]),
  ('quarantined_like', 1, 'active', 'serving', ARRAY['7D']::text[]);

-- This is the fixture equivalent of the migration-owned source authority:
-- an active serving source can still be excluded by a quarantine rule.
CREATE FUNCTION public.arena_freshness_expected_sources()
RETURNS TABLE (
  registry_slug text,
  filter_source text,
  exchange_name text,
  season_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    source_row.slug,
    source_row.slug,
    exchange_row.name,
    declared.season_id
  FROM arena.sources AS source_row
  JOIN arena.exchanges AS exchange_row
    ON exchange_row.id = source_row.exchange_id
  CROSS JOIN LATERAL pg_catalog.unnest(source_row.seasons)
    AS declared(season_id)
  WHERE source_row.status = 'active'
    AND source_row.serving_mode = 'serving'
    AND source_row.slug <> 'quarantined_like';
$function$;

ALTER FUNCTION public.arena_freshness_expected_sources() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_freshness_expected_sources()
  FROM PUBLIC, anon, authenticated, service_role, rogue_reader;
GRANT EXECUTE ON FUNCTION public.arena_freshness_expected_sources()
  TO service_role;

CREATE FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  p_rank public.leaderboard_ranks,
  p_observed_at timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    (p_rank).score_completeness IS NOT DISTINCT FROM 'full'
    AND (p_rank).metrics_estimated IS NOT DISTINCT FROM false
    AND (p_rank).is_outlier IS NOT TRUE
    AND (p_rank).arena_score IS NOT NULL
    AND (p_rank).arena_score > 0
    AND (p_rank).roi IS NOT NULL
    AND (p_rank).pnl IS NOT NULL
    AND (p_rank).win_rate IS NOT NULL
    AND (p_rank).max_drawdown IS NOT NULL
    AND (p_rank).computed_at IS NOT NULL
    AND (p_rank).computed_at >= p_observed_at - interval '48 hours'
    AND (p_rank).computed_at <= p_observed_at + interval '5 minutes',
    false
  );
$function$;

ALTER FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  public.leaderboard_ranks,
  timestamptz
) OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  public.leaderboard_ranks,
  timestamptz
) FROM PUBLIC, anon, authenticated, service_role, rogue_reader;
SQL

psql_db -q -f "$MIGRATION"

VIEW_ACL="$(psql_db -Atqc "
  SELECT
    relation.relowner::pg_catalog.regrole::text || '|' ||
    (relation.reloptions @> ARRAY[
      'security_barrier=true', 'security_invoker=false'
    ]::text[]) || '|' ||
    pg_catalog.has_table_privilege(
      'anon', 'public.public_ranked_leaderboard', 'SELECT'
    ) || '|' ||
    pg_catalog.has_table_privilege(
      'authenticated', 'public.public_ranked_leaderboard', 'SELECT'
    ) || '|' ||
    pg_catalog.has_table_privilege(
      'service_role', 'public.public_ranked_leaderboard', 'SELECT'
    ) || '|' ||
    pg_catalog.has_table_privilege(
      'rogue_reader', 'public.public_ranked_leaderboard', 'SELECT'
    ) || '|' ||
    pg_catalog.has_table_privilege(
      'anon', 'public.public_ranked_leaderboard', 'INSERT'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'anon', 'public.arena_freshness_expected_sources()', 'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'anon',
      'arena.public_ranked_leaderboard_source_is_expected(text,text)',
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'anon',
      'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamp with time zone)',
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'anon',
      'arena.public_ranked_leaderboard_row_is_eligible(public.leaderboard_ranks,timestamp with time zone)',
      'EXECUTE'
    )
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'public.public_ranked_leaderboard'::pg_catalog.regclass;")"
assert_equal "public ranked cohort view owner/options/ACL" \
  "postgres|true|true|true|true|false|false|false|true|false|true" "$VIEW_ACL"

WRAPPER_CONTRACT="$(psql_db -Atqc "
  SELECT
    function_row.proowner::pg_catalog.regrole::text || '|' ||
    pg_catalog.format_type(function_row.prorettype, NULL) || '|' ||
    function_row.proretset || '|' ||
    (function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp', 'row_security=off'
    ]::text[]) || '|' ||
    pg_catalog.has_function_privilege(
      'anon',
      'arena.public_ranked_leaderboard_source_is_expected(text,text)',
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'rogue_reader',
      'arena.public_ranked_leaderboard_source_is_expected(text,text)',
      'EXECUTE'
    )
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = pg_catalog.to_regprocedure(
    'arena.public_ranked_leaderboard_source_is_expected(text,text)'
  );")"
assert_equal "pair-scoped source wrapper owner/type/config/ACL" \
  "postgres|boolean|false|true|true|false" "$WRAPPER_CONTRACT"

ROW_WRAPPER_CONTRACT="$(psql_db -Atqc "
  SELECT
    function_row.proowner::pg_catalog.regrole::text || '|' ||
    pg_catalog.format_type(function_row.prorettype, NULL) || '|' ||
    function_row.proretset || '|' ||
    (function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp', 'row_security=off'
    ]::text[]) || '|' ||
    pg_catalog.has_function_privilege(
      'anon',
      'arena.public_ranked_leaderboard_row_is_eligible(public.leaderboard_ranks,timestamp with time zone)',
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'rogue_reader',
      'arena.public_ranked_leaderboard_row_is_eligible(public.leaderboard_ranks,timestamp with time zone)',
      'EXECUTE'
    )
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = pg_catalog.to_regprocedure(
    'arena.public_ranked_leaderboard_row_is_eligible(public.leaderboard_ranks,timestamp with time zone)'
  );")"
assert_equal "row eligibility wrapper owner/type/config/ACL" \
  "postgres|boolean|false|true|true|false" "$ROW_WRAPPER_CONTRACT"

VIEW_PRIVATE_COLUMN_COUNT="$(psql_db -Atqc "
  SELECT pg_catalog.count(*)
  FROM information_schema.columns AS column_row
  WHERE column_row.table_schema = 'public'
    AND column_row.table_name = 'public_ranked_leaderboard'
    AND column_row.column_name = 'score_factors';")"
assert_equal "public view omits internal score factors" "0" "$VIEW_PRIVATE_COLUMN_COUNT"

psql_db -q <<'SQL'
INSERT INTO public.leaderboard_ranks (
  id, season_id, source, source_type, source_trader_id, rank,
  arena_score, arena_score_v3, arena_score_v4, score_factors,
  roi, pnl, win_rate, max_drawdown, followers, copiers, trades_count,
  handle, avatar_url, computed_at, profitability_score, risk_control_score,
  execution_score, score_completeness, trading_style, avg_holding_hours,
  style_confidence, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio,
  trader_type, is_outlier, metrics_estimated, rank_change, is_new
)
VALUES
  (1, '7D', 'active_source', 'futures', 'eligible_one', 1,
   90, 89, 90, '{"roi":0.5}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Eligible One', NULL, statement_timestamp(), 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (2, '7D', 'active_source', 'futures', 'partial', 2,
   90, 89, 90, '{}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Partial', NULL, statement_timestamp(), 90, 80,
   70, 'partial', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (3, '7D', 'active_source', 'futures', 'estimated', 3,
   90, 89, 90, '{}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Estimated', NULL, statement_timestamp(), 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, true, 0, false),
  (4, '7D', 'active_source', 'futures', 'null_metric', 4,
   90, 89, 90, '{}'::jsonb,
   NULL, 1000, 60, 10, 100, 20, 30,
   'Null Metric', NULL, statement_timestamp(), 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (5, '7D', 'active_source', 'futures', 'stale', 5,
   90, 89, 90, '{}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Stale', NULL, statement_timestamp() - interval '49 hours', 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (6, '7D', 'active_source', 'futures', 'unranked', NULL,
   90, 89, 90, '{}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Unranked', NULL, statement_timestamp(), 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (7, '7D', 'inactive_source', 'futures', 'inactive', 7,
   90, 89, 90, '{}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Inactive', NULL, statement_timestamp(), 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (8, '7D', 'quarantined_like', 'futures', 'quarantined', 8,
   90, 89, 90, '{}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Quarantined', NULL, statement_timestamp(), 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (9, '30D', 'active_source', 'futures', 'wrong_season', 9,
   90, 89, 90, '{}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Wrong Season', NULL, statement_timestamp(), 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (10, '7D', 'active_source', 'futures', 'eligible_two', 10,
   89, 88, 89, '{}'::jsonb,
   11, 900, 59, 11, 99, 19, 29,
   'Eligible Two', NULL, statement_timestamp(), 89, 79,
   69, 'full', 'swing', 11, 0.7, 1.9, 2.9, 1.4, 1.1,
   'human', false, false, 0, false);
SQL

VISIBLE_ROWS="$(psql_db -Atqc "
  SET ROLE anon;
  SELECT COALESCE(
    pg_catalog.string_agg(source_trader_id, ',' ORDER BY rank),
    ''
  )
  FROM public.public_ranked_leaderboard;")"
assert_equal "only full/current/ranked/expected rows are public" \
  "eligible_one,eligible_two" "$VISIBLE_ROWS"

WRAPPER_BEHAVIOR="$(psql_db -Atqc "
  SET ROLE anon;
  SELECT
    COALESCE(
      arena.public_ranked_leaderboard_source_is_expected(
        'active_source', '7D'
      )::text,
      'NULL'
    ) || '|' ||
    COALESCE(
      arena.public_ranked_leaderboard_source_is_expected(
        'inactive_source', '7D'
      )::text,
      'NULL'
    ) || '|' ||
    COALESCE(
      arena.public_ranked_leaderboard_source_is_expected(
        'quarantined_like', '7D'
      )::text,
      'NULL'
    ) || '|' ||
    COALESCE(
      arena.public_ranked_leaderboard_source_is_expected(
        'active_source', '30D'
      )::text,
      'NULL'
    ) || '|' ||
    COALESCE(
      arena.public_ranked_leaderboard_source_is_expected(
        ' Active_Source ', '7D'
      )::text,
      'NULL'
    ) || '|' ||
    COALESCE(
      arena.public_ranked_leaderboard_source_is_expected(
        NULL, '7D'
      )::text,
      'NULL'
    );")"
assert_equal "wrapper only answers exact source-season membership" \
  "true|false|false|false|false|NULL" "$WRAPPER_BEHAVIOR"

OFFSET_ROW="$(psql_db -Atqc "
  SET ROLE anon;
  SELECT source_trader_id
  FROM public.public_ranked_leaderboard
  ORDER BY rank
  OFFSET 1 LIMIT 1;")"
assert_equal "view filters unsafe rows before caller OFFSET" "eligible_two" "$OFFSET_ROW"

set +e
psql_db -q >"$ERROR_FILE" 2>&1 <<'SQL'
SET ROLE anon;
SELECT * FROM public.arena_freshness_expected_sources();
SQL
DIRECT_AUTHORITY_STATUS=$?
set -e
if ((DIRECT_AUTHORITY_STATUS == 0)); then
  echo "anon unexpectedly executed the private expected-source authority" >&2
  exit 1
fi
rg -q 'permission denied for function arena_freshness_expected_sources' "$ERROR_FILE" || {
  echo "source authority denial failed for an unexpected reason" >&2
  sed -n '1,100p' "$ERROR_FILE" >&2
  exit 1
}

set +e
psql_db -q >"$ERROR_FILE" 2>&1 <<'SQL'
SET ROLE anon;
SELECT arena.leaderboard_rank_row_is_public_eligible(
  NULL::public.leaderboard_ranks,
  statement_timestamp()
);
SQL
DIRECT_ELIGIBILITY_STATUS=$?
set -e
if ((DIRECT_ELIGIBILITY_STATUS == 0)); then
  echo "anon unexpectedly executed the private row eligibility authority" >&2
  exit 1
fi
rg -q 'permission denied for function leaderboard_rank_row_is_public_eligible' "$ERROR_FILE" || {
  echo "row eligibility denial failed for an unexpected reason" >&2
  sed -n '1,100p' "$ERROR_FILE" >&2
  exit 1
}
