#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261127104836: the public leaderboard view
# evaluates the row policy inline, and returns exactly the same rows.
#
#   = the policy: arena.leaderboard_rank_row_is_public_eligible and the new
#     inlinable function give the 20261122201611 result on a matrix of
#     boundary rows (every condition just inside and just outside)
#   = the view: before and after, compared within one statement as anon
#     (one statement_timestamp), give the same rows across serving scenarios
#     at production scale (three seasons of 14,000 rows: ineligible rows,
#     idle rows, rank-null rows, rows of an older cohort, a stale source, an
#     isolated season over the bound, a season fence drift)
#   + the plan of the page query no longer calls a policy function per row
#     (it is inlined); timings before and after are printed
#   = owners, grants and columns; the new function is executable by the API
#     roles; a replay is accepted and changes nothing; an unexpected policy
#     body is refused
# The migration is applied by a non-superuser owner. Isolated cluster on a
# private socket; never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
GATE_MIGRATION="$MIGRATIONS/20260816184500_public_ranked_leaderboard_source_freshness_gate.sql"
SEALED_READERS_MIGRATION="$MIGRATIONS/20261113012028_public_snapshot_readers_sealed_freshness.sql"
EVIDENCE_MIGRATION="$MIGRATIONS/20261113110430_rank_publication_source_evidence_binding.sql"
WINDOW_FLAGS_MIGRATION="$MIGRATIONS/20261123021904_public_ranked_leaderboard_window_flags.sql"
VISIBLE_MIGRATION="$MIGRATIONS/20261121201553_visible_sources_from_served_ranks.sql"
STALE_MIGRATION="$MIGRATIONS/20261124114140_stale_source_hides_only_its_own_rows.sql"
NEW_MIGRATION="$MIGRATIONS/20261127104836_public_ranked_leaderboard_inline_row_policy.sql"
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
  PGOPTIONS="-c client_min_messages=warning" "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U "$role" -d postgres "$@"
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
  id bigint GENERATED ALWAYS AS IDENTITY,
  season_id text NOT NULL, source text NOT NULL, source_type text, source_trader_id text NOT NULL,
  rank integer, arena_score numeric, arena_score_v3 numeric, arena_score_v4 numeric,
  roi numeric, pnl numeric, win_rate numeric, max_drawdown numeric, followers integer,
  copiers integer, trades_count integer, handle text, avatar_url text,
  computed_at timestamptz NOT NULL, profitability_score numeric, risk_control_score numeric,
  execution_score numeric, score_completeness text, trading_style text,
  avg_holding_hours numeric, style_confidence numeric, sharpe_ratio numeric,
  sortino_ratio numeric, profit_factor numeric, calmar_ratio numeric, trader_type text,
  is_outlier boolean, metrics_estimated boolean, rank_change integer, is_new boolean,
  rank_publication_id uuid, score_factors jsonb,
  PRIMARY KEY (id, season_id), UNIQUE (season_id, source, source_trader_id)
) PARTITION BY LIST (season_id);
CREATE TABLE public.lr_7d PARTITION OF public.leaderboard_ranks FOR VALUES IN ('7D');
CREATE TABLE public.lr_30d PARTITION OF public.leaderboard_ranks FOR VALUES IN ('30D');
CREATE TABLE public.lr_90d PARTITION OF public.leaderboard_ranks FOR VALUES IN ('90D');
CREATE TABLE public.lr_default PARTITION OF public.leaderboard_ranks DEFAULT;
CREATE INDEX idx_lr_part_season_rank ON public.leaderboard_ranks USING btree (season_id, rank);
CREATE INDEX idx_lr_part_season_score ON public.leaderboard_ranks USING btree (season_id, arena_score DESC);

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

{
  statement_of "$MIGRATIONS/20261122201611_row_eligibility_roi_pnl_only.sql" \
    'CREATE OR REPLACE FUNCTION arena.leaderboard_rank_row_is_public_eligible(' '$function$;'
  echo 'ALTER FUNCTION arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks, timestamptz) OWNER TO postgres;'
  echo 'REVOKE ALL ON FUNCTION arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks, timestamptz) FROM PUBLIC;'
  statement_of "$MIGRATIONS/20260816151614_public_ranked_leaderboard.sql" \
    'CREATE FUNCTION arena.public_ranked_leaderboard_row_is_eligible(' ') TO anon, authenticated, service_role;'
} >"$TMP_ROOT/eligibility.sql"
psql_as postgres -q -f "$TMP_ROOT/eligibility.sql" >/dev/null

# The definitions in force before this migration, taken from their migrations.
{
  statement_of "$GATE_MIGRATION" \
    'CREATE FUNCTION arena.public_ranked_leaderboard_serving_seasons(' \
    '  TO anon, authenticated, service_role;'
  statement_of "$WINDOW_FLAGS_MIGRATION" \
    'CREATE OR REPLACE VIEW public.public_ranked_leaderboard' \
    '  );'
  echo "ALTER VIEW public.public_ranked_leaderboard OWNER TO postgres;"
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


psql_as postgres -q -f "$STALE_MIGRATION" >/dev/null

# --- the policy before, on a matrix of boundary rows --------------------------
psql_as postgres -q <<'SQL'
CREATE TABLE fixture.policy_rows (LIKE public.leaderboard_ranks);
ALTER TABLE fixture.policy_rows ALTER COLUMN computed_at DROP NOT NULL;
-- A base row that passes, then one field at a time just inside / just outside.
INSERT INTO fixture.policy_rows (id, season_id, source, source_trader_id, rank, arena_score, roi, pnl,
  win_rate, max_drawdown, score_completeness, metrics_estimated, is_outlier, computed_at)
SELECT n, '90D', source, trader, 1, score, roi, pnl, win_rate, mdd, completeness, estimated, outlier,
       '2026-11-27 12:00+00'::timestamptz + computed_offset
FROM (VALUES
  (1, 'binance_futures', 't', 50::numeric, 10::numeric, 100::numeric, NULL::numeric, NULL::numeric, 'minimal', false, false, interval '0'),
  (2, 'Binance_futures', 't', 50, 10, 100, NULL, NULL, 'minimal', false, false, interval '0'),
  (3, 'binance__futures', 't', 50, 10, 100, NULL, NULL, 'minimal', false, false, interval '0'),
  (4, 'binance_futures', ' t', 50, 10, 100, NULL, NULL, 'minimal', false, false, interval '0'),
  (5, 'binance_futures', '', 50, 10, 100, NULL, NULL, 'minimal', false, false, interval '0'),
  (6, 'binance_futures', 't', 50, 10, 100, 55, 20, 'full', false, false, interval '0'),
  (7, 'binance_futures', 't', 50, 10, 100, 55, 20, 'partial', false, false, interval '0'),
  (8, 'binance_futures', 't', 50, 10, 100, 55, NULL, 'partial', false, false, interval '0'),
  (9, 'binance_futures', 't', 50, 10, 100, NULL, 20, 'full', false, false, interval '0'),
  (10, 'binance_futures', 't', 50, 10, 100, NULL, NULL, NULL, false, false, interval '0'),
  (11, 'binance_futures', 't', 50, 10, 100, NULL, NULL, 'minimal', true, false, interval '0'),
  (12, 'binance_futures', 't', 50, 10, 100, NULL, NULL, 'minimal', NULL, false, interval '0'),
  (13, 'binance_futures', 't', 50, 10, 100, NULL, NULL, 'minimal', false, true, interval '0'),
  (14, 'binance_futures', 't', 50, 10, 100, NULL, NULL, 'minimal', false, NULL, interval '0'),
  (15, 'binance_futures', 't', 0, 10, 100, NULL, NULL, 'minimal', false, false, interval '0'),
  (16, 'binance_futures', 't', 0.01, 10, 100, NULL, NULL, 'minimal', false, false, interval '0'),
  (17, 'binance_futures', 't', 100, 10, 100, NULL, NULL, 'minimal', false, false, interval '0'),
  (18, 'binance_futures', 't', 100.01, 10, 100, NULL, NULL, 'minimal', false, false, interval '0'),
  (19, 'binance_futures', 't', NULL, 10, 100, NULL, NULL, 'minimal', false, false, interval '0'),
  (20, 'binance_futures', 't', 50, -10000, 100, NULL, NULL, 'minimal', false, false, interval '0'),
  (21, 'binance_futures', 't', 50, -10000.01, 100, NULL, NULL, 'minimal', false, false, interval '0'),
  (22, 'binance_futures', 't', 50, 10000, 100, NULL, NULL, 'minimal', false, false, interval '0'),
  (23, 'binance_futures', 't', 50, 10000.01, 100, NULL, NULL, 'minimal', false, false, interval '0'),
  (24, 'binance_futures', 't', 50, NULL, 100, NULL, NULL, 'minimal', false, false, interval '0'),
  (25, 'binance_futures', 't', 50, 10, -100000000, NULL, NULL, 'minimal', false, false, interval '0'),
  (26, 'binance_futures', 't', 50, 10, -100000000.01, NULL, NULL, 'minimal', false, false, interval '0'),
  (27, 'binance_futures', 't', 50, 10, 1000000000, NULL, NULL, 'minimal', false, false, interval '0'),
  (28, 'binance_futures', 't', 50, 10, 1000000000.01, NULL, NULL, 'minimal', false, false, interval '0'),
  (29, 'binance_futures', 't', 50, 10, NULL, NULL, NULL, 'minimal', false, false, interval '0'),
  (30, 'binance_futures', 't', 50, 10, 100, 0, 0, 'full', false, false, interval '0'),
  (31, 'binance_futures', 't', 50, 10, 100, -0.01, 0, 'full', false, false, interval '0'),
  (32, 'binance_futures', 't', 50, 10, 100, 100, 99.99, 'full', false, false, interval '0'),
  (33, 'binance_futures', 't', 50, 10, 100, 100.01, 10, 'full', false, false, interval '0'),
  (34, 'binance_futures', 't', 50, 10, 100, 10, 100, 'full', false, false, interval '0'),
  (35, 'binance_futures', 't', 50, 10, 100, NULL, NULL, 'minimal', false, false, interval '-48 hours'),
  (36, 'binance_futures', 't', 50, 10, 100, NULL, NULL, 'minimal', false, false, interval '-48 hours -1 second'),
  (37, 'binance_futures', 't', 50, 10, 100, NULL, NULL, 'minimal', false, false, interval '5 minutes'),
  (38, 'binance_futures', 't', 50, 10, 100, NULL, NULL, 'minimal', false, false, interval '5 minutes 1 second')
) AS matrix(n, source, trader, score, roi, pnl, win_rate, mdd, completeness, estimated, outlier, computed_offset);
INSERT INTO fixture.policy_rows (id, season_id, source, source_trader_id, rank, arena_score, roi, pnl,
  score_completeness, metrics_estimated, is_outlier, computed_at)
VALUES (39, '90D', 'binance_futures', 't', 1, 50, 10, 100, 'minimal', false, false, NULL);
CREATE TABLE fixture.policy_before AS
SELECT row_value.id,
       arena.leaderboard_rank_row_is_public_eligible(ROW(row_value.*)::public.leaderboard_ranks, '2026-11-27 12:00+00') AS eligible
  FROM fixture.policy_rows AS row_value;
SQL
# Accepted: the base row, full/partial/minimal each matching its metrics, a NULL
# outlier flag, and every bound exactly at its limit; refused: everything else.
assert_equal "the 20261122201611 policy accepts exactly the expected matrix rows" \
  "1,6,8,14,16,17,20,22,25,27,30,32,35,37" \
  "$(psql_as postgres -Atqc "SELECT string_agg(id::text, ',' ORDER BY id) FROM fixture.policy_before WHERE eligible")"

# --- three production-scale seasons -------------------------------------------
SPEC="$(python3 -c "import json;print(json.dumps([{'source':f's{i:02d}','age_hours':3+i%10,'rows':560} for i in range(25)]))")"
populate() {
  psql_as postgres -q <<'SQL'
UPDATE public.leaderboard_ranks
   SET arena_score = 100 - rank::numeric / 200, roi = 10, pnl = 100,
       score_completeness = 'minimal', metrics_estimated = false, is_outlier = false,
       score_factors = CASE WHEN rank % 3 = 0 THEN '{"idle_window": true}'::jsonb
                            WHEN rank % 7 = 0 THEN '{"mdd_contradiction": true}'::jsonb
                            ELSE '{}'::jsonb END
 WHERE source <> 'old';
-- Rows the policy refuses, one reason each.
UPDATE public.leaderboard_ranks SET is_outlier = true WHERE rank % 29 = 0;
UPDATE public.leaderboard_ranks SET roi = NULL WHERE rank % 31 = 0;
UPDATE public.leaderboard_ranks SET win_rate = 50 WHERE rank % 37 = 0;
UPDATE public.leaderboard_ranks SET win_rate = 50, max_drawdown = 20, score_completeness = 'full' WHERE rank % 41 = 0;
UPDATE public.leaderboard_ranks SET computed_at = computed_at - interval '3 days' WHERE rank % 43 = 0;
UPDATE public.leaderboard_ranks SET arena_score = 0 WHERE rank % 47 = 0;
-- Rows of an older cohort, and rank-null leftovers, as in production.
UPDATE public.leaderboard_ranks SET rank_publication_id = gen_random_uuid() WHERE rank % 53 = 0;
INSERT INTO public.leaderboard_ranks (season_id, source, source_trader_id, rank, computed_at)
SELECT s, 's01', 'old-' || n, NULL, now() FROM unnest(ARRAY['7D','30D','90D']) s, generate_series(1, 3000) n
ON CONFLICT DO NOTHING;
ANALYZE public.leaderboard_ranks;
SQL
}
for season in 7D 30D 90D; do seal "$season" "$SPEC"; done
populate

# The view as it is now, kept for comparison.
psql_as postgres -q <<SQL
CREATE VIEW fixture.leaderboard_before WITH (security_barrier = true) AS
$(psql_as postgres -Atqc "SELECT pg_get_viewdef('public.public_ranked_leaderboard'::regclass)")
GRANT USAGE ON SCHEMA fixture TO anon;
GRANT SELECT ON fixture.leaderboard_before TO anon;
SQL

PAGE="SELECT * FROM %s WHERE season_id = '90D' AND idle_window = false ORDER BY rank LIMIT 51"
COUNT="SELECT count(*) FROM %s WHERE season_id = '90D' AND idle_window"
timing() {
  psql_as anon -Atqc "EXPLAIN (ANALYZE, SUMMARY ON) $(printf "$1" "$2")" | sed -n 's/^Execution Time: //p'
}
echo "before: page $(timing "$PAGE" public.public_ranked_leaderboard), idle count $(timing "$COUNT" public.public_ranked_leaderboard)"

shape_after() {
  psql_as postgres -Atqc "
    SELECT c.relowner::regrole::text || '|' || array_to_string(c.reloptions, ',') || '|' ||
           coalesce(array_to_string(c.relacl, ','), '') || '|' ||
           (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum)
              FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0)
      FROM pg_class c WHERE c.oid = 'public.public_ranked_leaderboard'::regclass
    UNION ALL
    SELECT p.proowner::regrole::text || '|' || p.provolatile::text || '|' || p.proparallel::text || '|' ||
           coalesce(array_to_string(p.proconfig, ','), '') || '|' || coalesce(array_to_string(p.proacl, ','), '') || '|' ||
           coalesce(obj_description(p.oid, 'pg_proc'), '')
      FROM pg_proc p
     WHERE p.oid = 'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamptz)'::regprocedure"
}
BEFORE_SHAPE="$(shape_after)"

psql_as postgres -q -f "$NEW_MIGRATION" >/dev/null
echo "ok: the migration applies as a non-superuser owner"
assert_equal "view owner, options, grants, columns and the policy function's attributes are unchanged" \
  "$BEFORE_SHAPE" "$(shape_after)"
assert_equal "the API roles can execute the inlinable policy; PUBLIC cannot" "t:t:t:f" \
  "$(psql_as postgres -Atqc "
     SELECT has_function_privilege('anon', 'arena.leaderboard_rank_row_is_public_eligible_expr(public.leaderboard_ranks,timestamptz)', 'EXECUTE')
            || ':' || has_function_privilege('authenticated', 'arena.leaderboard_rank_row_is_public_eligible_expr(public.leaderboard_ranks,timestamptz)', 'EXECUTE')
            || ':' || has_function_privilege('service_role', 'arena.leaderboard_rank_row_is_public_eligible_expr(public.leaderboard_ranks,timestamptz)', 'EXECUTE')
            || ':' || (SELECT count(*) > 0 FROM pg_proc p, aclexplode(p.proacl) acl
                        WHERE p.oid = 'arena.leaderboard_rank_row_is_public_eligible_expr(public.leaderboard_ranks,timestamptz)'::regprocedure
                          AND acl.grantee = 0)" | sed 's/true/t/g; s/false/f/g')"

# The new function is executable by anon, so it must stay a pure expression:
# it may depend only on columns of public.leaderboard_ranks (its argument's
# fields) and built-ins. A FROM, a subquery or a user function adds a
# dependency on a whole relation or on a non-built-in function.
relation_dependencies() {
  psql_as postgres -Atqc "
    SELECT count(*) FROM pg_depend AS dependency
     WHERE dependency.classid = 'pg_proc'::regclass
       AND dependency.objid = '$1'::regprocedure
       AND dependency.deptype = 'n'
       AND ((dependency.refclassid = 'pg_class'::regclass
             AND NOT (dependency.refobjid = 'public.leaderboard_ranks'::regclass
                      AND dependency.refobjsubid > 0))
            OR dependency.refclassid = 'pg_proc'::regclass)"
}
assert_equal "the inlinable policy reads no relation and calls no user function" "0" \
  "$(relation_dependencies 'arena.leaderboard_rank_row_is_public_eligible_expr(public.leaderboard_ranks,timestamptz)')"
psql_as postgres -q <<'SQL'
CREATE FUNCTION fixture.reads_a_table(p_rank public.leaderboard_ranks, p_observed_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE
RETURN (p_rank).roi IS NOT NULL AND EXISTS (SELECT 1 FROM arena.sources WHERE slug = (p_rank).source);
CREATE FUNCTION fixture.calls_a_function(p_rank public.leaderboard_ranks, p_observed_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE
RETURN arena.leaderboard_rank_row_is_public_eligible_expr(p_rank, p_observed_at);
SQL
assert_equal "the check catches a body that reads a table" "1" \
  "$(relation_dependencies 'fixture.reads_a_table(public.leaderboard_ranks,timestamptz)')"
assert_equal "the check catches a body that calls a user function" "1" \
  "$(relation_dependencies 'fixture.calls_a_function(public.leaderboard_ranks,timestamptz)')"

assert_equal "the policy gives the 20261122201611 result on every matrix row (both functions)" "0" \
  "$(psql_as postgres -Atqc "
     SELECT count(*) FROM fixture.policy_rows AS row_value
       JOIN fixture.policy_before AS before USING (id)
      WHERE arena.leaderboard_rank_row_is_public_eligible(ROW(row_value.*)::public.leaderboard_ranks, '2026-11-27 12:00+00') IS DISTINCT FROM before.eligible
         OR arena.leaderboard_rank_row_is_public_eligible_expr(ROW(row_value.*)::public.leaderboard_ranks, '2026-11-27 12:00+00') IS DISTINCT FROM before.eligible")"

same_rows() {
  # One statement, so both views see one statement_timestamp.
  psql_as anon -Atqc "
    WITH b AS (SELECT * FROM fixture.leaderboard_before),
         a AS (SELECT * FROM public.public_ranked_leaderboard)
    SELECT (SELECT count(*) FROM (SELECT * FROM b EXCEPT ALL SELECT * FROM a) AS x)
           + (SELECT count(*) FROM (SELECT * FROM a EXCEPT ALL SELECT * FROM b) AS y)
           || ':' || (SELECT count(*) FROM a)"
}
check_same() {
  local result
  result="$(same_rows)"
  if [[ "${result%%:*}" != "0" ]]; then
    echo "$1: the views differ ($result)" >&2
    exit 1
  fi
  echo "ok: $1 (${result#*:} rows, identical)"
}

check_same "three seasons, ineligible, idle, older-cohort and rank-null rows"
echo "after:  page $(timing "$PAGE" public.public_ranked_leaderboard), idle count $(timing "$COUNT" public.public_ranked_leaderboard)"

VERBOSE_PLAN="$(psql_as anon -Atqc "EXPLAIN (VERBOSE, COSTS OFF) $(printf "$PAGE" public.public_ranked_leaderboard)")"
if grep -qE "leaderboard_rank_row_is_public_eligible|public_ranked_leaderboard_row_is_eligible" <<<"$VERBOSE_PLAN"; then
  echo "the page plan still calls a policy function per row" >&2
  echo "$VERBOSE_PLAN" >&2
  exit 1
fi
echo "ok: the page plan evaluates the policy inline"
BEFORE_PLAN="$(psql_as anon -Atqc "EXPLAIN (VERBOSE, COSTS OFF) $(printf "$PAGE" fixture.leaderboard_before)")"
grep -q "public_ranked_leaderboard_row_is_eligible" <<<"$BEFORE_PLAN"
echo "ok: the previous view called the wrapper per row"

# A stale source with rows (it alone loses its rows).
STALE_SPEC="$(python3 -c "import json;print(json.dumps([{'source':f's{i:02d}','age_hours':(49 if i == 3 else 3+i%10),'rows':560} for i in range(25)]))")"
seal 30D "$STALE_SPEC"; populate
check_same "a stale source in 30D"

# More than half of the declared sources isolated: the season is not served.
SMALL_SPEC="$(python3 -c "import json;print(json.dumps([{'source':f's{i:02d}','age_hours':3,'rows':300} for i in range(5)]))")"
seal 7D "$SMALL_SPEC" '{s05,s06,s07,s08,s09,s10}'
populate
check_same "7D over the isolation bound"
assert_equal "7D over the isolation bound serves nothing" "0" \
  "$(psql_as anon -Atqc "SELECT count(*) FROM public.public_ranked_leaderboard WHERE season_id = '7D'")"

# Integrity drift: the 90D season fence moved after the seal.
psql_as postgres -q -c "UPDATE arena.leaderboard_rank_season_mutation_fences SET mutation_seq = mutation_seq + 1 WHERE season_id = '90D'"
check_same "a 90D season fence drift"
assert_equal "the drifted 90D season serves nothing" "0" \
  "$(psql_as anon -Atqc "SELECT count(*) FROM public.public_ranked_leaderboard WHERE season_id = '90D'")"

psql_as postgres -q -f "$NEW_MIGRATION" >/dev/null
check_same "a replay changes nothing"


psql_as postgres -q <<'SQL'
CREATE OR REPLACE FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  p_rank public.leaderboard_ranks, p_observed_at timestamptz
) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp
AS $function$ SELECT true $function$;
SQL
if psql_as postgres -q -f "$NEW_MIGRATION" >/dev/null 2>"$TMP_ROOT/refused.err"; then
  echo "the migration replaced an unexpected policy body" >&2
  exit 1
fi
grep -q 'unexpected body of arena.leaderboard_rank_row_is_public_eligible' "$TMP_ROOT/refused.err"
echo "ok: an unexpected policy body is refused"

echo "public ranked leaderboard inline row policy PostgreSQL 17 proof passed"
