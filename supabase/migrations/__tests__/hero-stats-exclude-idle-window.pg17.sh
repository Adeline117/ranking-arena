#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for 20261124225312_hero_stats_exclude_idle_window:
# public.get_hero_stats() counts only public rows with idle_window = false.
#
#   1. The fixture installs the view (20260816184500 + 20261123021904) and the
#      function from the migration that last defined it (20261114103025), and
#      checks that its body digest is the one the migration accepts.
#   2. The migration runs as a NOSUPERUSER postgres role (as on Supabase).
#   3. Idle rows are not counted, and a source served only through idle rows is
#      not counted as a board; other seasons still do not count.
#   4. Old rule (no row is idle, both flags false everywhere): the function
#      returns exactly what it returned before the migration.
#   5. Owner, SECURITY DEFINER, configuration (search_path and the 2 second
#      statement_timeout, no custom parameter), ACL and return type are
#      unchanged; anon can still execute it and still cannot read the table.
#   6. Replay changes nothing.
#   7. Drift (body, owner, security, configuration, missing column, missing
#      function) makes the whole migration refuse and leaves the function as it
#      was.
#   8. The read-only statement handed to the release owner for timing returns
#      what the function returns.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
MIGRATION="$MIGRATIONS/20261124225312_hero_stats_exclude_idle_window.sql"
HERO_BASELINE="$MIGRATIONS/20261114103025_hero_stats_sealed_public_cohort.sql"
VIEW_BASELINE="$MIGRATIONS/20260816184500_public_ranked_leaderboard_source_freshness_gate.sql"
VIEW_FLAGS="$MIGRATIONS/20261123021904_public_ranked_leaderboard_window_flags.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

CURRENT_BODY_SHA256='9462c36f5e983078e8e25479aa8ad7235a448d428f7abeaebaa2ab3bfcaaf944'
NEW_BODY_SHA256='9cfaca2859c780d4ae0b2c886a4f1c0f5cf48accb5341ff3308710a132528b4b'

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

TMP_ROOT="$(mktemp -d /tmp/hero-stats-idle-pg17.XXXXXX)"
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
    -h "$SOCKET_DIR" -p "$PORT" -U supabase_admin -d "$DB" "$@"
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

body_sha256() {
  psql_cmd -Atqc "
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(prosrc, 'UTF8')), 'hex')
    FROM pg_catalog.pg_proc
    WHERE oid = pg_catalog.to_regprocedure('public.get_hero_stats()');
  "
}

# Everything but the body.
function_attributes() {
  psql_cmd -Atqc "
    SELECT pg_catalog.concat_ws('|',
      procedure_row.oid::pg_catalog.text,
      pg_catalog.pg_get_userbyid(procedure_row.proowner),
      (SELECT lanname FROM pg_catalog.pg_language WHERE oid = procedure_row.prolang),
      procedure_row.prokind,
      procedure_row.prosecdef,
      procedure_row.provolatile,
      procedure_row.proparallel,
      procedure_row.proisstrict,
      procedure_row.proleakproof,
      pg_catalog.pg_get_function_result(procedure_row.oid),
      procedure_row.proconfig::pg_catalog.text,
      procedure_row.proacl::pg_catalog.text,
      COALESCE(pg_catalog.obj_description(procedure_row.oid, 'pg_proc'), '<no comment>'))
    FROM pg_catalog.pg_proc AS procedure_row
    WHERE procedure_row.oid = pg_catalog.to_regprocedure('public.get_hero_stats()');
  "
}

# The function as the website calls it.
hero_stats() {
  psql_cmd -Atqc "SET ROLE anon; SELECT exchange_count || '|' || trader_count FROM public.get_hero_stats()" | tail -1
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
CREATE ROLE no_grant NOLOGIN NOSUPERUSER;
GRANT anon, authenticated, service_role, other_owner, no_grant TO postgres;
GRANT CREATE ON DATABASE postgres TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL
if [[ "$(psql_cmd -Atqc "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user")" != "f" ]]; then
  echo "migrations must run as a non-superuser postgres role" >&2
  exit 1
fi

# The relations and functions the view reads (as in the window-flags proof).
# The season authority and the row policy are stand-ins: this proof is about
# what the hero function counts.
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

# The view exactly as 20260816184500 defines it, with its owner and grants.
awk '
  /^CREATE OR REPLACE VIEW public\.public_ranked_leaderboard$/ { printing = 1 }
  printing { print }
  printing && /^  \);$/ { exit }
' "$VIEW_BASELINE" >"$TMP_ROOT/baseline-view.sql"
if ! grep -q 'arena.public_ranked_leaderboard_row_is_eligible(' "$TMP_ROOT/baseline-view.sql"; then
  echo "could not extract the view definition from $VIEW_BASELINE" >&2
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

# 1. The function exactly as the repository last defined it (20261114103025),
#    applied by the non-superuser postgres role.
PGOPTIONS='-c client_min_messages=warning' psql_cmd -q -f "$HERO_BASELINE" >/dev/null
expect_eq "the repository body is the body the migration accepts" \
  "$(body_sha256)" "$CURRENT_BODY_SHA256"
expect_eq "current configuration: search_path and a 2 second statement_timeout, nothing custom" \
  "$(psql_cmd -Atqc "SELECT proconfig::text FROM pg_catalog.pg_proc WHERE oid = pg_catalog.to_regprocedure('public.get_hero_stats()')")" \
  '{"search_path=pg_catalog, pg_temp",statement_timeout=2s}'
expect_eq "current ACL" \
  "$(psql_cmd -Atqc "SELECT proacl::text FROM pg_catalog.pg_proc WHERE oid = pg_catalog.to_regprocedure('public.get_hero_stats()')")" \
  "{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}"

# A database where the view has not received the flag columns yet (7g).
psql_admin -q -c "CREATE DATABASE drift_no_flags TEMPLATE postgres OWNER postgres"

# The view gains idle_window / mdd_contradiction (20261123021904).
psql_cmd -q -f "$VIEW_FLAGS"

# Served rows. 90D is the season the function counts; 7D is served too and
# must stay out of the count.
psql_cmd -q <<'SQL'
INSERT INTO arena.public_ranked_leaderboard_serving_heads VALUES
  ('90D', '00000000-0000-4000-8000-000000000001'),
  ('7D',  '00000000-0000-4000-8000-000000000007');
INSERT INTO arena.public_ranked_leaderboard_serving_sources VALUES
  ('90D', 'bybit',  '00000000-0000-4000-8000-000000000001'),
  ('90D', 'okx',    '00000000-0000-4000-8000-000000000001'),
  ('90D', 'xt',     '00000000-0000-4000-8000-000000000001'),
  ('7D',  'gateio', '00000000-0000-4000-8000-000000000007');

INSERT INTO public.leaderboard_ranks (
  id, season_id, source, source_type, source_trader_id, rank, arena_score, roi, pnl,
  win_rate, max_drawdown, score_completeness, is_outlier, metrics_estimated, is_new,
  computed_at, score_factors, rank_publication_id
)
SELECT
  fixture.id, fixture.season, fixture.source, 'futures', fixture.trader, fixture.id::integer,
  fixture.score, fixture.roi, fixture.pnl, fixture.win_rate, fixture.max_drawdown,
  fixture.completeness, false, false, false, pg_catalog.now(), fixture.factors::jsonb,
  fixture.cohort::uuid
FROM (VALUES
  -- scored rows on two sources
  (1,  '90D', 'bybit', 'scored-1',  88.10, 40,  9000, 61,   8,    'full',
   '{"roi":0.9,"pnl":0.5}', '00000000-0000-4000-8000-000000000001'),
  (2,  '90D', 'bybit', 'scored-2',  41.00, 12,  700,  52,   14,   'full',
   NULL, '00000000-0000-4000-8000-000000000001'),
  (3,  '90D', 'okx',   'scored-3',  30.00, 5,   100,  NULL, 10,   'partial',
   '{"idle_window":false,"mdd_contradiction":false}', '00000000-0000-4000-8000-000000000001'),
  -- a loss whose 0% drawdown was refused: it has performance, it counts
  (4,  '90D', 'okx',   'refused-dd', 12.40, -12, -900, 55,  NULL, 'partial',
   '{"mdd_contradiction":true}', '00000000-0000-4000-8000-000000000001'),
  -- the lowest scored row
  (5,  '90D', 'okx',   'lowest',    0.02,  -80, -5000, NULL, NULL, 'minimal',
   '{"roi":0,"pnl":0}', '00000000-0000-4000-8000-000000000001'),
  -- "true" as a string is not the mark: the view reads false, the row counts
  (6,  '90D', 'bybit', 'string-true', 0.50, 3,  50,   50,   10,   'full',
   '{"idle_window":"true"}', '00000000-0000-4000-8000-000000000001'),
  -- idle rows, ranked last: on sources that also have scored rows...
  (7,  '90D', 'bybit', 'idle-1',    0.01,  0,   0,    0,    0,    'full',
   '{"idle_window":true}', '00000000-0000-4000-8000-000000000001'),
  (8,  '90D', 'okx',   'idle-2',    0.01,  0,   0,    NULL, NULL, 'minimal',
   '{"idle_window":true}', '00000000-0000-4000-8000-000000000001'),
  -- ...and on a source served through idle rows only
  (9,  '90D', 'xt',    'idle-3',    0.01,  0,   0,    NULL, NULL, 'minimal',
   '{"idle_window":true}', '00000000-0000-4000-8000-000000000001'),
  (10, '90D', 'xt',    'idle-4',    0.01,  0,   0,    NULL, NULL, 'minimal',
   '{"idle_window":true,"mdd_contradiction":true}', '00000000-0000-4000-8000-000000000001'),
  -- another served season
  (11, '7D',  'gateio', 'other-season', 70.00, 9, 400,  50,   10,   'full',
   NULL, '00000000-0000-4000-8000-000000000007'),
  -- not served: refused by the row policy, another cohort
  (12, '90D', 'bybit', 'not-eligible', 0.00, 1,  1,    50,   10,   'full',
   NULL, '00000000-0000-4000-8000-000000000001'),
  (13, '90D', 'bybit', 'other-cohort', 50.00, 1, 1,    50,   10,   'full',
   NULL, '00000000-0000-4000-8000-000000000002')
) AS fixture(id, season, source, trader, score, roi, pnl, win_rate, max_drawdown,
             completeness, factors, cohort);
SQL

expect_eq "served 90D rows: 10, of which 4 idle, on 3 sources" \
  "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) || '|' || pg_catalog.count(*) FILTER (WHERE idle_window) || '|' || pg_catalog.count(DISTINCT source) FROM public.public_ranked_leaderboard WHERE season_id = '90D'")" \
  "10|4|3"
expect_eq "idle rows are ranked after every scored row" \
  "$(psql_cmd -Atqc "SELECT pg_catalog.max(rank) FILTER (WHERE NOT idle_window) < pg_catalog.min(rank) FILTER (WHERE idle_window) FROM public.public_ranked_leaderboard WHERE season_id = '90D'")" \
  "t"
# Before: every served 90D row and every served source is counted.
expect_eq "before: the function counts idle rows and idle-only sources" "$(hero_stats)" "3|10"
ATTRIBUTES_BEFORE="$(function_attributes)"

# Copies of this exact state for the drift cases and for the old-rule case.
for copy_db in old_rule drift_body drift_owner drift_security drift_config drift_custom_guc drift_missing; do
  psql_admin -q -c "CREATE DATABASE $copy_db TEMPLATE postgres OWNER postgres"
done

# 2. Apply as the non-superuser postgres role.
psql_cmd -q -f "$MIGRATION"
expect_eq "installed body digest" "$(body_sha256)" "$NEW_BODY_SHA256"

# 3. Idle rows and idle-only sources are not counted.
expect_eq "after: 6 rows with performance on 2 sources" "$(hero_stats)" "2|6"
expect_eq "the count is the served 90D rows that are not idle" \
  "$(hero_stats)" \
  "$(psql_cmd -Atqc "SELECT pg_catalog.count(DISTINCT source) || '|' || pg_catalog.count(*) FROM public.public_ranked_leaderboard WHERE season_id = '90D' AND idle_window = false")"
# The percentile the profile badge derives (1 - rank / trader_count): a scored
# row's rank is inside the count, an idle row's rank is outside it.
expect_eq "scored ranks are inside the count, idle ranks outside" \
  "$(psql_cmd -Atqc "
    SELECT pg_catalog.bool_and(ranked.rank <= 6) FILTER (WHERE NOT ranked.idle_window)
      || '|' || pg_catalog.bool_and(ranked.rank > 6) FILTER (WHERE ranked.idle_window)
    FROM public.public_ranked_leaderboard AS ranked WHERE ranked.season_id = '90D'")" \
  "true|true"
for role in authenticated service_role; do
  expect_eq "$role reads the same counts" \
    "$(psql_cmd -Atqc "SET ROLE $role; SELECT exchange_count || '|' || trader_count FROM public.get_hero_stats()" | tail -1)" \
    "2|6"
done

# 5. Nothing but the body moved.
expect_eq "owner, security, configuration, ACL, return type and comment" \
  "$(function_attributes)" "$ATTRIBUTES_BEFORE"
expect_eq "still SECURITY DEFINER, owned by postgres, 2 second timeout, no custom parameter" \
  "$(psql_cmd -Atqc "
    SELECT pg_catalog.concat_ws('|', prosecdef, pg_catalog.pg_get_userbyid(proowner), proconfig::text,
      NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(proconfig) AS entry
                  WHERE pg_catalog.strpos(pg_catalog.split_part(entry, '=', 1), '.') > 0))
    FROM pg_catalog.pg_proc WHERE oid = pg_catalog.to_regprocedure('public.get_hero_stats()')")" \
  't|postgres|{"search_path=pg_catalog, pg_temp",statement_timeout=2s}|t'
expect_eq "privileges" \
  "$(psql_cmd -Atqc "
    SELECT pg_catalog.concat_ws('|',
      pg_catalog.has_function_privilege('anon', 'public.get_hero_stats()', 'EXECUTE'),
      pg_catalog.has_function_privilege('authenticated', 'public.get_hero_stats()', 'EXECUTE'),
      pg_catalog.has_function_privilege('service_role', 'public.get_hero_stats()', 'EXECUTE'),
      pg_catalog.has_function_privilege('no_grant', 'public.get_hero_stats()', 'EXECUTE'),
      pg_catalog.has_table_privilege('anon', 'public.leaderboard_ranks', 'SELECT'))")" \
  "t|t|t|f|f"
if psql_cmd -Atqc "SET ROLE no_grant; SELECT * FROM public.get_hero_stats()" >/dev/null 2>&1; then
  echo "a role without a grant can execute public.get_hero_stats()" >&2
  exit 1
fi

# 8. The read-only statement handed to the release owner for timing is the
#    function body; it returns what the function returns and can be explained.
TIMING_SELECT="SELECT pg_catalog.count(DISTINCT ranked.source), pg_catalog.count(*)
FROM public.public_ranked_leaderboard AS ranked
WHERE ranked.season_id = '90D'
  AND NOT ranked.idle_window"
expect_eq "the timing statement returns what the function returns" \
  "$(psql_cmd -AtqF '|' -c "$TIMING_SELECT")" "$(hero_stats)"
expect_eq "the timing statement is the migration's function body" \
  "$(printf '%s' "$TIMING_SELECT" | tr -s '[:space:]' ' ')" \
  "$(awk '/^AS \$function\$$/ { printing = 1; next } /^\$function\$;$/ { printing = 0 } printing { print }' "$MIGRATION" \
      | tr -s '[:space:]' ' ' | sed 's/^ //; s/; *$//')"
psql_cmd -q -c "BEGIN; SET LOCAL statement_timeout = '10s'; EXPLAIN (ANALYZE, BUFFERS) $TIMING_SELECT; ROLLBACK;" >/dev/null

# 6. Replay: accepted, and nothing changes.
psql_cmd -q -f "$MIGRATION"
expect_eq "replay body digest" "$(body_sha256)" "$NEW_BODY_SHA256"
expect_eq "replay attributes" "$(function_attributes)" "$ATTRIBUTES_BEFORE"
expect_eq "replay counts" "$(hero_stats)" "2|6"

# 4. Old rule: no row carries a mark, so both flags are false on every row
#    and the function returns what it returned before the migration.
DB=old_rule
psql_cmd -q -c "UPDATE public.leaderboard_ranks SET score_factors = '{\"roi\":0.5,\"pnl\":0.5,\"drawdown\":0.5,\"sharpe\":null,\"consistency\":0.5}'"
expect_eq "old rule: both flags false on every served row" \
  "$(psql_cmd -Atqc "SELECT pg_catalog.bool_or(idle_window) || '|' || pg_catalog.bool_or(mdd_contradiction) || '|' || pg_catalog.count(*) FROM public.public_ranked_leaderboard")" \
  "false|false|11"
OLD_RULE_BEFORE="$(hero_stats)"
expect_eq "old rule: counts before the migration" "$OLD_RULE_BEFORE" "3|10"
psql_cmd -q -f "$MIGRATION"
expect_eq "old rule: installed body digest" "$(body_sha256)" "$NEW_BODY_SHA256"
expect_eq "old rule: the function returns exactly what it returned before" \
  "$(hero_stats)" "$OLD_RULE_BEFORE"
# An empty board is still a real 0, not an error.
psql_cmd -q -c "DELETE FROM arena.public_ranked_leaderboard_serving_heads WHERE season_id = '90D'"
expect_eq "old rule: an unserved season counts 0" "$(hero_stats)" "0|0"

# 7. Drift: each case must make the migration refuse and change nothing.
refuses() {
  local label="$1" expected_message="$2" output digest_before attributes_before
  digest_before="$(body_sha256)"
  attributes_before="$(function_attributes)"
  if output="$(psql_cmd -q -f "$MIGRATION" 2>&1)"; then
    echo "$label: the migration ran against a drifted function" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected_message"* ]]; then
    echo "$label: refused for an unexpected reason:" >&2
    echo "$output" >&2
    exit 1
  fi
  expect_eq "$label left the body alone" "$(body_sha256)" "$digest_before"
  expect_eq "$label left the attributes alone" "$(function_attributes)" "$attributes_before"
}

# 7a. An unreviewed body (the pre-20261114103025 kind: reads the raw table).
DB=drift_body
psql_cmd -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_hero_stats()
RETURNS TABLE(exchange_count bigint, trader_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '2s'
AS $function$
  SELECT pg_catalog.count(DISTINCT ranked.source), pg_catalog.count(*)
  FROM public.leaderboard_ranks AS ranked
  WHERE ranked.season_id = '90D';
$function$;
SQL
refuses "unreviewed body" "unexpected body of public.get_hero_stats()"
expect_eq "unreviewed body: still the drifted function" "$(hero_stats)" "3|12"

# 7b. Owner.
DB=drift_owner
psql_cmd -q -c "ALTER FUNCTION public.get_hero_stats() OWNER TO other_owner"
refuses "another owner" "unexpected attributes"

# 7c. SECURITY INVOKER.
DB=drift_security
psql_cmd -q -c "ALTER FUNCTION public.get_hero_stats() SECURITY INVOKER"
refuses "security invoker" "unexpected attributes"

# 7d. Configuration: another timeout, then no search_path.
DB=drift_config
psql_cmd -q -c "ALTER FUNCTION public.get_hero_stats() SET statement_timeout = '30s'"
refuses "another statement_timeout" "unexpected attributes"
psql_cmd -q -c "ALTER FUNCTION public.get_hero_stats() SET statement_timeout = '2s'"
psql_cmd -q -c "ALTER FUNCTION public.get_hero_stats() RESET search_path"
refuses "search_path removed" "unexpected attributes"

# 7e. A custom parameter attached to the function. The non-superuser postgres
#     role cannot attach one; a superuser could have.
DB=drift_custom_guc
if psql_cmd -q -c "ALTER FUNCTION public.get_hero_stats() SET arena.hero_stats_mode = 'all'" >/dev/null 2>&1; then
  echo "the non-superuser postgres role attached a custom parameter" >&2
  exit 1
fi
psql_admin -q -c "ALTER FUNCTION public.get_hero_stats() SET arena.hero_stats_mode = 'all'"
refuses "custom parameter attached" "unexpected attributes"

# 7f. The function is missing.
DB=drift_missing
psql_cmd -q -c "ALTER FUNCTION public.get_hero_stats() RENAME TO get_hero_stats_moved"
if output="$(psql_cmd -q -f "$MIGRATION" 2>&1)"; then
  echo "missing function: the migration created a function" >&2
  exit 1
fi
if [[ "$output" != *"public.get_hero_stats() does not exist"* ]]; then
  echo "missing function: refused for an unexpected reason:" >&2
  echo "$output" >&2
  exit 1
fi
expect_eq "missing function: nothing was created" \
  "$(psql_cmd -Atqc "SELECT pg_catalog.to_regprocedure('public.get_hero_stats()') IS NULL")" "t"

# 7g. The view has no idle_window column yet (20261123021904 not applied).
DB=drift_no_flags
refuses "view without idle_window" "apply 20261123021904 first"

echo "hero stats exclude idle-window rows PostgreSQL 17 proof passed"
