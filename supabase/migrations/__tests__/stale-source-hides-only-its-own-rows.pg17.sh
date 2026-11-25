#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261124114140: a serving source whose sealed
# watermark leaves the 48-hour window hides only its own rows.
#
#   - before: one stale zero-row source hides the whole season (the
#     2026-11-24 production incident: 12 witnesses, bitget_spot at 49 hours)
#   + after: the other sources' rows are served; the stale source is not
#     listed by any reader (view, sealed sources, evidence, visible sources)
#   + a stale or future-dated source with rows loses exactly its own rows
#   - the publisher's isolation bound still hides the season: more than half
#     of the declared sources not current (isolated ones included), or every
#     declared core source not current (declared by the head, an isolation or
#     the cohort's unsupported list)
#   - integrity drift (season fence, freshness tuple, expected set, expired
#     head) still hides the whole season
#   = signatures, owners, grants; helpers stay owner-only; the bound equals
#     the publisher's TypeScript constants; a replay is refused
# The migration is applied by a non-superuser owner. Isolated cluster on a
# private socket; never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
GATE_MIGRATION="$MIGRATIONS/20260816184500_public_ranked_leaderboard_source_freshness_gate.sql"
SEALED_READERS_MIGRATION="$MIGRATIONS/20261113012028_public_snapshot_readers_sealed_freshness.sql"
EVIDENCE_MIGRATION="$MIGRATIONS/20261113110430_rank_publication_source_evidence_binding.sql"
VISIBLE_MIGRATION="$MIGRATIONS/20261121201553_visible_sources_from_served_ranks.sql"
NEW_MIGRATION="$MIGRATIONS/20261124114140_stale_source_hides_only_its_own_rows.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/stale-source-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((53000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -40 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_as() {
  local role="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U "$role" -d postgres "$@"
}

assert_equal() {
  if [[ "$2" != "$3" ]]; then
    echo "$1: expected '$2', got '$3'" >&2
    exit 1
  fi
  echo "ok: $1"
}

# Prints the statements of an applied migration from the first line that is
# exactly $2 or starts with it, through the next line that equals $3.
statement_of() {
  FIRST_LINE="$2" LAST_LINE="$3" awk '
    !printing && index($0, ENVIRON["FIRST_LINE"]) == 1 { printing = 1 }
    printing { print }
    printing && $0 == ENVIRON["LAST_LINE"] { exit }
  ' "$1"
}

# Seals season $1 from spec $2 ([{"source","age_hours","rows"}]) with the
# isolated sources $3 and the cohort's unsupported sources $4.
seal() {
  local empty='{}'
  local isolated="${3:-$empty}"
  local unsupported="${4:-$empty}"
  psql_as postgres -q -c \
    "SELECT fixture.seal('$1', '$2'::jsonb, '$isolated'::text[], '$unsupported'::text[])" >/dev/null
}

# Rows the public view serves for season $1, as source:count pairs (anon).
served_rows() {
  psql_as anon -Atqc "
    SELECT COALESCE(string_agg(source || ':' || n, ',' ORDER BY source), 'none')
      FROM (SELECT source, count(*) AS n FROM public.public_ranked_leaderboard
             WHERE season_id = '$1' GROUP BY source) AS per_source"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U bootstrap --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

psql_as bootstrap -q <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE;
CREATE ROLE anon LOGIN NOSUPERUSER;
CREATE ROLE authenticated NOSUPERUSER;
CREATE ROLE service_role NOSUPERUSER;
GRANT CREATE ON DATABASE postgres TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL

psql_as postgres -q <<'SQL'
CREATE SCHEMA arena;
CREATE SCHEMA fixture;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role;

CREATE TABLE arena.exchanges (id int PRIMARY KEY, slug text NOT NULL, name text NOT NULL);
CREATE TABLE arena.sources (
  id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, slug text NOT NULL UNIQUE,
  exchange_id int NOT NULL REFERENCES arena.exchanges, product_type text NOT NULL,
  status text NOT NULL, serving_mode text NOT NULL, meta jsonb NOT NULL DEFAULT '{}'
);
INSERT INTO arena.exchanges VALUES (1, 'fixture', 'Fixture');

CREATE TABLE public.leaderboard_ranks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  season_id text NOT NULL, source text NOT NULL, source_type text, source_trader_id text NOT NULL,
  rank integer, arena_score numeric, arena_score_v3 numeric, arena_score_v4 numeric,
  roi numeric, pnl numeric, win_rate numeric, max_drawdown numeric, followers integer,
  copiers integer, trades_count integer, handle text, avatar_url text,
  computed_at timestamptz NOT NULL, profitability_score numeric, risk_control_score numeric,
  execution_score numeric, score_completeness text, trading_style text,
  avg_holding_hours numeric, style_confidence numeric, sharpe_ratio numeric,
  sortino_ratio numeric, profit_factor numeric, calmar_ratio numeric, trader_type text,
  is_outlier boolean, metrics_estimated boolean, rank_change integer, is_new boolean,
  rank_publication_id uuid
);
-- Row eligibility is not under test: every fixture row is eligible.
CREATE FUNCTION arena.public_ranked_leaderboard_row_is_eligible(
  p_rank public.leaderboard_ranks, p_observed_at timestamptz
) RETURNS boolean LANGUAGE sql STABLE STRICT AS $$ SELECT true $$;
GRANT EXECUTE ON FUNCTION arena.public_ranked_leaderboard_row_is_eligible(
  public.leaderboard_ranks, timestamptz
) TO anon, authenticated, service_role;

CREATE TABLE public.leaderboard_source_freshness (
  season_id text NOT NULL, source text NOT NULL, source_as_of timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL, score_cohort_id uuid, rank_mutation_seq bigint,
  published_rank_count integer, published_identity_sha256 text,
  PRIMARY KEY (season_id, source)
);
CREATE TABLE arena.leaderboard_rank_mutation_fences (
  season_id text NOT NULL, source text NOT NULL, mutation_seq bigint NOT NULL,
  PRIMARY KEY (season_id, source)
);
CREATE TABLE arena.leaderboard_rank_season_mutation_fences (
  season_id text PRIMARY KEY, mutation_seq bigint NOT NULL
);
CREATE TABLE arena.leaderboard_rank_publications (
  id uuid PRIMARY KEY, season_id text NOT NULL, source_count integer NOT NULL,
  proofs jsonb NOT NULL, published_at timestamptz NOT NULL, UNIQUE (id, season_id)
);
CREATE TABLE arena.public_ranked_leaderboard_serving_heads (
  season_id text PRIMARY KEY, score_cohort_id uuid NOT NULL,
  rank_mutation_epoch bigint NOT NULL, rank_valid_until timestamptz NOT NULL,
  expected_sources text[] NOT NULL, sealed_at timestamptz NOT NULL
);
CREATE TABLE arena.public_ranked_leaderboard_serving_sources (
  season_id text NOT NULL, source text NOT NULL, score_cohort_id uuid NOT NULL,
  source_as_of timestamptz NOT NULL, recorded_at timestamptz NOT NULL,
  rank_mutation_seq bigint NOT NULL, published_rank_count integer NOT NULL,
  published_identity_sha256 text NOT NULL, PRIMARY KEY (season_id, source)
);
CREATE TABLE arena.leaderboard_publication_source_isolations (
  season_id text NOT NULL, filter_source text NOT NULL, reasons text[] NOT NULL,
  first_isolated_at timestamptz NOT NULL, isolated_at timestamptz NOT NULL,
  score_cohort_id uuid NOT NULL, PRIMARY KEY (season_id, filter_source)
);
CREATE TABLE arena.leaderboard_publication_unsupported_sources (
  season_id text NOT NULL, score_cohort_id uuid NOT NULL, filter_sources text[] NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  PRIMARY KEY (season_id, score_cohort_id)
);
CREATE TABLE arena.leaderboard_rank_publication_source_evidence (
  score_cohort_id uuid NOT NULL, season_id text NOT NULL, source text NOT NULL,
  evidence_grade text NOT NULL, PRIMARY KEY (score_cohort_id, source)
);

-- Stand-in for the registry-derived expected set.
CREATE TABLE fixture.expected (season_id text NOT NULL, filter_source text NOT NULL);
CREATE FUNCTION public.arena_freshness_expected_sources()
RETURNS TABLE (registry_slug text, filter_source text, exchange_name text, season_id text)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT expected.filter_source, expected.filter_source, 'Fixture'::text, expected.season_id
  FROM fixture.expected AS expected
$$;

-- One complete sealed publication of a season, as the seal transaction
-- leaves it: ranks, both fences, freshness proofs, receipt, head, witnesses.
CREATE FUNCTION fixture.seal(
  p_season text, p_spec jsonb, p_isolated text[], p_unsupported text[]
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_cohort uuid := pg_catalog.gen_random_uuid();
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_sealed_at timestamptz := pg_catalog.clock_timestamp() - interval '10 minutes';
BEGIN
  DELETE FROM public.leaderboard_ranks WHERE season_id = p_season;
  DELETE FROM public.leaderboard_source_freshness WHERE season_id = p_season;
  DELETE FROM arena.leaderboard_rank_mutation_fences WHERE season_id = p_season;
  DELETE FROM arena.leaderboard_rank_season_mutation_fences WHERE season_id = p_season;
  DELETE FROM arena.public_ranked_leaderboard_serving_sources WHERE season_id = p_season;
  DELETE FROM arena.public_ranked_leaderboard_serving_heads WHERE season_id = p_season;
  DELETE FROM arena.leaderboard_publication_source_isolations WHERE season_id = p_season;
  DELETE FROM fixture.expected WHERE season_id = p_season;

  INSERT INTO arena.sources (slug, exchange_id, product_type, status, serving_mode)
  SELECT spec.source, 1, 'futures', 'active', 'serving'
  FROM pg_catalog.jsonb_to_recordset(p_spec) AS spec(source text)
  ON CONFLICT (slug) DO NOTHING;

  INSERT INTO fixture.expected
  SELECT p_season, spec.source
  FROM pg_catalog.jsonb_to_recordset(p_spec) AS spec(source text);

  INSERT INTO arena.leaderboard_publication_source_isolations
  SELECT p_season, isolated.source, ARRAY['stale'], v_sealed_at, v_sealed_at, v_cohort
  FROM pg_catalog.unnest(p_isolated) AS isolated(source);

  IF pg_catalog.cardinality(p_unsupported) > 0 THEN
    INSERT INTO arena.leaderboard_publication_unsupported_sources
      (season_id, score_cohort_id, filter_sources)
    VALUES (p_season, v_cohort, p_unsupported);
  END IF;

  INSERT INTO public.leaderboard_ranks
    (season_id, source, source_trader_id, rank, computed_at, rank_publication_id)
  SELECT p_season, spec.source, spec.source || '-' || trader.n,
         (pg_catalog.row_number() OVER ())::integer, v_sealed_at, v_cohort
  FROM pg_catalog.jsonb_to_recordset(p_spec) AS spec(source text, rows integer)
  CROSS JOIN LATERAL pg_catalog.generate_series(1, spec.rows) AS trader(n);

  INSERT INTO arena.leaderboard_rank_season_mutation_fences VALUES (p_season, 1);
  INSERT INTO arena.leaderboard_rank_mutation_fences
  SELECT p_season, spec.source, 1
  FROM pg_catalog.jsonb_to_recordset(p_spec) AS spec(source text);

  INSERT INTO public.leaderboard_source_freshness
  SELECT p_season, spec.source,
         v_now - pg_catalog.make_interval(secs => spec.age_hours * 3600),
         v_sealed_at, v_cohort, 1, spec.rows,
         pg_catalog.md5(spec.source) || pg_catalog.md5(p_season)
  FROM pg_catalog.jsonb_to_recordset(p_spec)
    AS spec(source text, age_hours double precision, rows integer);

  INSERT INTO arena.leaderboard_rank_publications
  SELECT v_cohort, p_season, pg_catalog.count(*)::integer,
         pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'source', freshness.source,
           'source_as_of', pg_catalog.to_char(
             freshness.source_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'recorded_at', pg_catalog.to_char(
             freshness.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'score_cohort_id', freshness.score_cohort_id,
           'rank_mutation_seq', freshness.rank_mutation_seq,
           'published_rank_count', freshness.published_rank_count,
           'published_identity_sha256', freshness.published_identity_sha256
         )),
         v_sealed_at
  FROM public.leaderboard_source_freshness AS freshness
  WHERE freshness.season_id = p_season;

  INSERT INTO arena.public_ranked_leaderboard_serving_heads
  SELECT p_season, v_cohort, 1, v_now + interval '40 hours',
         pg_catalog.array_agg(freshness.source ORDER BY freshness.source COLLATE "C"),
         v_sealed_at
  FROM public.leaderboard_source_freshness AS freshness
  WHERE freshness.season_id = p_season;

  INSERT INTO arena.public_ranked_leaderboard_serving_sources
  SELECT freshness.season_id, freshness.source, freshness.score_cohort_id,
         freshness.source_as_of, freshness.recorded_at, freshness.rank_mutation_seq,
         freshness.published_rank_count, freshness.published_identity_sha256
  FROM public.leaderboard_source_freshness AS freshness
  WHERE freshness.season_id = p_season;

  INSERT INTO arena.leaderboard_rank_publication_source_evidence
  SELECT v_cohort, p_season, freshness.source, 'attempt_bound'
  FROM public.leaderboard_source_freshness AS freshness
  WHERE freshness.season_id = p_season;
END
$$;
SQL

# The definitions in force before this migration, taken from their migrations.
{
  statement_of "$GATE_MIGRATION" \
    'CREATE FUNCTION arena.public_ranked_leaderboard_serving_seasons(' \
    '  TO anon, authenticated, service_role;'
  statement_of "$GATE_MIGRATION" \
    'CREATE OR REPLACE VIEW public.public_ranked_leaderboard' \
    'ALTER VIEW public.public_ranked_leaderboard OWNER TO postgres;'
  echo "GRANT SELECT ON public.public_ranked_leaderboard TO anon, authenticated, service_role;"
  statement_of "$SEALED_READERS_MIGRATION" \
    'CREATE OR REPLACE FUNCTION arena.public_sealed_rank_sources()' \
    'GRANT EXECUTE ON FUNCTION arena.public_sealed_rank_sources() TO service_role;'
  statement_of "$EVIDENCE_MIGRATION" \
    'CREATE OR REPLACE VIEW public.public_ranked_leaderboard_source_evidence' \
    '  TO anon, authenticated, service_role;'
} >"$TMP_ROOT/before.sql"
psql_as postgres -q -f "$TMP_ROOT/before.sql" >/dev/null
psql_as postgres -q -f "$VISIBLE_MIGRATION" >/dev/null

shape_of() {
  psql_as postgres -Atqc "
    SELECT string_agg(
             p.oid::regprocedure || '|' || pg_get_function_result(p.oid) || '|' ||
             pg_get_userbyid(p.proowner) || '|' || p.prosecdef || '|' || p.provolatile::text ||
             '|' || p.proisstrict || '|' || coalesce(array_to_string(p.proacl, ','), ''),
             E'\n' ORDER BY p.oid::regprocedure::text)
      FROM pg_proc p
     WHERE p.oid IN (
       'arena.public_ranked_leaderboard_serving_seasons(timestamptz)'::regprocedure,
       'arena.public_sealed_rank_sources()'::regprocedure,
       'public.arena_visible_sources(text)'::regprocedure)
    UNION ALL
    SELECT string_agg(
             c.oid::regclass || '|' || pg_get_userbyid(c.relowner) || '|' ||
             array_to_string(c.reloptions, ',') || '|' || coalesce(array_to_string(c.relacl, ','), '') ||
             '|' || (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ','
                                       ORDER BY a.attnum)
                       FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0),
             E'\n' ORDER BY c.oid::regclass::text)
      FROM pg_class c
     WHERE c.oid IN ('public.public_ranked_leaderboard'::regclass,
                     'public.public_ranked_leaderboard_source_evidence'::regclass)"
}

# The 2026-11-24 production 7D head: 12 witnesses, six isolated sources,
# bitget_spot sealed at 47.3 hours with zero rows and now past 48 hours.
PRODUCTION_7D='[
  {"source":"binance_futures","age_hours":3,"rows":5},
  {"source":"bybit","age_hours":5,"rows":4},
  {"source":"bitget_futures","age_hours":6,"rows":3},
  {"source":"hyperliquid","age_hours":4,"rows":2},
  {"source":"gate","age_hours":8,"rows":2},
  {"source":"mexc","age_hours":9,"rows":1},
  {"source":"htx","age_hours":10,"rows":1},
  {"source":"kucoin","age_hours":11,"rows":1},
  {"source":"coinex","age_hours":12,"rows":1},
  {"source":"blofin","age_hours":15,"rows":1},
  {"source":"bingx","age_hours":17,"rows":1},
  {"source":"bitget_spot","age_hours":49,"rows":0}
]'
seal 7D "$PRODUCTION_7D" '{binance_web3,bitget_cfd,btcc,bybit_mt5,okx_futures,okx_spot}'

assert_equal "before: one stale zero-row source hides the whole season" "none" "$(served_rows 7D)"

BEFORE_SHAPE="$(shape_of)"
psql_as postgres -q -f "$NEW_MIGRATION" >/dev/null
assert_equal "signatures, owners, security, options, columns and grants are unchanged" \
  "$BEFORE_SHAPE" "$(shape_of)"

ALL_ELEVEN="binance_futures:5,bingx:1,bitget_futures:3,blofin:1,bybit:4,coinex:1,gate:2,htx:1,hyperliquid:2,kucoin:1,mexc:1"
assert_equal "after: the eleven current sources are served (anon)" "$ALL_ELEVEN" "$(served_rows 7D)"
assert_equal "the stale source is not a served source" "11:false" \
  "$(psql_as anon -Atqc "
     SELECT count(*) || ':' || bool_or(source = 'bitget_spot')
       FROM arena.public_ranked_leaderboard_served_sources(statement_timestamp())
      WHERE season_id = '7D'")"
assert_equal "the sealed-source reader lists the same eleven" "11:false" \
  "$(psql_as postgres -Atqc "
     SELECT count(*) || ':' || bool_or(filter_source = 'bitget_spot')
       FROM arena.public_sealed_rank_sources() WHERE season_id = '7D'")"
assert_equal "the public evidence view lists the same eleven, with their grade" "11:false:attempt_bound" \
  "$(psql_as anon -Atqc "
     SELECT count(*) || ':' || bool_or(source = 'bitget_spot') || ':' || min(evidence_grade)
       FROM public.public_ranked_leaderboard_source_evidence WHERE season_id = '7D'")"
assert_equal "visible sources are the eleven with published ranks" "11:22" \
  "$(psql_as anon -Atqc "SELECT count(*) || ':' || sum(trader_count) FROM public.arena_visible_sources('7D')")"

# A stale source with rows loses exactly its own rows.
seal 90D '[
  {"source":"binance_futures","age_hours":3,"rows":5},
  {"source":"gate","age_hours":50,"rows":4},
  {"source":"mexc","age_hours":2,"rows":3},
  {"source":"htx","age_hours":1,"rows":1}
]'
assert_equal "a stale source with rows loses only its own rows" \
  "binance_futures:5,htx:1,mexc:3" "$(served_rows 90D)"
assert_equal "and is not a visible source" "binance_futures,htx,mexc" \
  "$(psql_as anon -Atqc "SELECT string_agg(filter_source, ',' ORDER BY filter_source)
       FROM public.arena_visible_sources('90D')")"
assert_equal "another season is unaffected" "$ALL_ELEVEN" "$(served_rows 7D)"

# Integrity drift still hides the whole season (each in a rolled-back transaction).
drifted_rows() {
  psql_as postgres -Atqc "BEGIN; $1;
    SELECT count(*) FROM public.public_ranked_leaderboard WHERE season_id = '90D'; ROLLBACK;" |
    grep -E '^[0-9]+$'
}
assert_equal "a season rank mutation still hides the season" "0" \
  "$(drifted_rows "UPDATE arena.leaderboard_rank_season_mutation_fences SET mutation_seq = 2 WHERE season_id = '90D'")"
assert_equal "a source rank mutation still hides the season" "0" \
  "$(drifted_rows "UPDATE arena.leaderboard_rank_mutation_fences SET mutation_seq = 2 WHERE season_id = '90D' AND source = 'htx'")"
assert_equal "a changed freshness proof still hides the season" "0" \
  "$(drifted_rows "UPDATE public.leaderboard_source_freshness SET source_as_of = source_as_of - interval '1 second' WHERE season_id = '90D' AND source = 'mexc'")"
assert_equal "a changed expected set still hides the season" "0" \
  "$(drifted_rows "INSERT INTO fixture.expected VALUES ('90D', 'okx_futures')")"
assert_equal "an expired head still hides the season" "0" \
  "$(drifted_rows "UPDATE arena.public_ranked_leaderboard_serving_heads SET rank_valid_until = statement_timestamp() - interval '1 second' WHERE season_id = '90D'")"
assert_equal "without drift the season is served" "9" "$(drifted_rows "SELECT 1 WHERE false")"

# A future-dated watermark: beyond the five-minute tolerance it is not served.
seal 90D '[
  {"source":"binance_futures","age_hours":3,"rows":5},
  {"source":"gate","age_hours":-0.2,"rows":4},
  {"source":"mexc","age_hours":-0.05,"rows":3}
]'
assert_equal "a watermark 12 minutes ahead loses only its own rows; 3 minutes ahead is served" \
  "binance_futures:5,mexc:3" "$(served_rows 90D)"

# The publisher's ratio: more than half of the declared sources not current.
seal 30D '[
  {"source":"binance_futures","age_hours":3,"rows":5},
  {"source":"gate","age_hours":50,"rows":4},
  {"source":"mexc","age_hours":60,"rows":3},
  {"source":"htx","age_hours":1,"rows":1}
]'
assert_equal "exactly half of the sources not current: still served" \
  "binance_futures:5,htx:1" "$(served_rows 30D)"
seal 30D '[
  {"source":"binance_futures","age_hours":3,"rows":5},
  {"source":"gate","age_hours":50,"rows":4},
  {"source":"mexc","age_hours":60,"rows":3},
  {"source":"htx","age_hours":70,"rows":1}
]'
assert_equal "more than half not current: the season is not served" "none" "$(served_rows 30D)"
seal 30D '[
  {"source":"binance_futures","age_hours":3,"rows":5},
  {"source":"gate","age_hours":50,"rows":4},
  {"source":"mexc","age_hours":2,"rows":3},
  {"source":"htx","age_hours":1,"rows":1}
]' '{coinex,kucoin}'
assert_equal "isolated sources count as declared and not current: 3 of 6 is served" \
  "binance_futures:5,htx:1,mexc:3" "$(served_rows 30D)"
seal 30D '[
  {"source":"binance_futures","age_hours":3,"rows":5},
  {"source":"gate","age_hours":50,"rows":4},
  {"source":"mexc","age_hours":60,"rows":3},
  {"source":"htx","age_hours":1,"rows":1}
]' '{coinex}'
assert_equal "isolated plus stale past half (3 of 5): the season is not served" "none" "$(served_rows 30D)"

# The publisher's core rule: every declared core source not current.
seal 30D '[
  {"source":"binance_futures","age_hours":50,"rows":5},
  {"source":"bybit","age_hours":55,"rows":4},
  {"source":"gate","age_hours":2,"rows":3},
  {"source":"mexc","age_hours":2,"rows":2},
  {"source":"htx","age_hours":1,"rows":1},
  {"source":"kucoin","age_hours":1,"rows":1}
]'
assert_equal "every declared core source stale: the season is not served" "none" "$(served_rows 30D)"
seal 30D '[
  {"source":"binance_futures","age_hours":50,"rows":5},
  {"source":"bybit","age_hours":5,"rows":4},
  {"source":"gate","age_hours":2,"rows":3},
  {"source":"mexc","age_hours":2,"rows":2},
  {"source":"htx","age_hours":1,"rows":1},
  {"source":"kucoin","age_hours":1,"rows":1}
]'
assert_equal "one core source current: served without the stale core source" \
  "bybit:4,gate:3,htx:1,kucoin:1,mexc:2" "$(served_rows 30D)"
NO_CORE='[
  {"source":"gate","age_hours":2,"rows":3},
  {"source":"mexc","age_hours":2,"rows":2},
  {"source":"htx","age_hours":1,"rows":1}
]'
seal 30D "$NO_CORE"
assert_equal "a season that declares no core source is served" "gate:3,htx:1,mexc:2" "$(served_rows 30D)"
seal 30D "$NO_CORE" '{okx_futures}'
assert_equal "a core source declared only by its isolation, none current: not served" "none" "$(served_rows 30D)"
seal 30D "$NO_CORE" '{}' '{hyperliquid}'
assert_equal "a core source declared only as unsupported, none current: not served" "none" "$(served_rows 30D)"
seal 30D "$NO_CORE" '{}' '{toobit}'
assert_equal "a non-core unsupported source does not declare a core source" \
  "gate:3,htx:1,mexc:2" "$(served_rows 30D)"

# The bound is the publisher's.
TS_BOUND="$(cd "$ROOT_DIR" && npx tsx -e "
  import('./lib/rankings/publication/publish-season.ts').then((m) => {
    console.log([...m.RANK_PUBLICATION_CORE_SOURCES].join(',') + '|' + m.RANK_PUBLICATION_MAX_ISOLATED_RATIO)
  })")"
assert_equal "core sources and ratio equal the publisher's TypeScript constants" "$TS_BOUND" \
  "$(psql_as postgres -Atqc "
     SELECT array_to_string(arena.rank_publication_core_sources(), ',') || '|' ||
            arena.rank_publication_max_isolated_ratio()::double precision")"

assert_equal "the bound helpers stay owner-only" "false:false:false" \
  "$(psql_as postgres -Atqc "
     SELECT has_function_privilege('anon', 'arena.rank_publication_core_sources()', 'EXECUTE') || ':' ||
            has_function_privilege('service_role', 'arena.rank_publication_max_isolated_ratio()', 'EXECUTE') || ':' ||
            has_function_privilege('authenticated',
              'arena.public_ranked_leaderboard_witness_is_current(timestamptz,timestamptz)', 'EXECUTE')")"
assert_equal "the served-sources capability has the season gate's grants" "true:true:true" \
  "$(psql_as postgres -Atqc "
     SELECT has_function_privilege('anon', f, 'EXECUTE') || ':' ||
            has_function_privilege('authenticated', f, 'EXECUTE') || ':' ||
            has_function_privilege('service_role', f, 'EXECUTE')
       FROM (SELECT 'arena.public_ranked_leaderboard_served_sources(timestamptz)'::regprocedure AS f) AS s")"

if psql_as postgres -q -f "$NEW_MIGRATION" >/dev/null 2>"$TMP_ROOT/replay.err"; then
  echo "replaying the migration was not refused" >&2
  exit 1
fi
echo "ok: a replay is refused"

echo "stale source hides only its own rows PostgreSQL 17 proof passed"
