#!/usr/bin/env bash

# PostgreSQL 17 adversarial proof for the BingX public-rank quarantine. It
# owns an isolated cluster and never connects to application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260804045000_quarantine_bingx_rank_authority.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql createdb; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi
if [[ ! -f "$MIGRATION" ]]; then
  echo "Required migration not found: $MIGRATION" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/bingx-rank-quarantine-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((57500 + ($$ % 1500)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code="$1"
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -240 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap 'cleanup $?' EXIT

psql_postgres() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

psql_db() {
  local database="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d "$database" "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "$label changed: expected=$expected actual=$actual" >&2
    exit 1
  fi
}

assert_sql_fails() {
  local database="$1"
  local label="$2"
  local sql="$3"
  local output
  if output="$(psql_db "$database" -q -c "$sql" 2>&1)"; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ "$output" != *"violates check constraint"* ]]; then
    echo "$label failed for the wrong reason: $output" >&2
    exit 1
  fi
}

assert_migration_fails() {
  local database="$1"
  local label="$2"
  local expected="$3"
  local output
  if output="$(psql_db "$database" -q -f "$MIGRATION" 2>&1)"; then
    echo "$label migration unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected"* ]]; then
    echo "$label migration failed for the wrong reason: $output" >&2
    exit 1
  fi
}

preservation_fingerprint() {
  local database="$1"
  psql_db "$database" -Atqc "
    SELECT pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id), '') FROM arena.leaderboard_snapshots AS row_value)
          || '|' ||
          (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id), '') FROM arena.leaderboard_entries AS row_value)
          || '|' ||
          (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id), '') FROM arena.traders AS row_value)
          || '|' ||
          (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id), '') FROM arena.trader_stats AS row_value)
          || '|' ||
          (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id), '') FROM arena.trader_series AS row_value)
          || '|' ||
          (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id), '') FROM arena.raw_captures AS row_value)
          || '|' ||
          (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id), '') FROM arena.trader_position_history AS row_value),
          'UTF8'
        )
      ),
      'hex'
    );"
}

rank_surface_fingerprint() {
  local database="$1"
  psql_db "$database" -Atqc "
    SELECT pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.season_id, row_value.source, row_value.source_trader_id), '') FROM public.leaderboard_ranks AS row_value)
          || '|' ||
          (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.season_id, row_value.source), '') FROM public.leaderboard_source_freshness AS row_value)
          || '|' ||
          (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.season_id, row_value.source), '') FROM public.leaderboard_count_cache AS row_value),
          'UTF8'
        )
      ),
      'hex'
    );"
}

setup_case() {
  local database="$1"
  "$PG_BIN/createdb" -h "$SOCKET_DIR" -p "$PORT" -U postgres "$database"
  psql_db "$database" -q <<'SQL'
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role;

CREATE TABLE arena.exchanges (
  id smallint PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  exchange_id smallint NOT NULL REFERENCES arena.exchanges(id),
  product_type text NOT NULL,
  trader_kind_scope text NOT NULL,
  adapter_slug text NOT NULL,
  timeframes_native integer[] NOT NULL,
  timeframes_derived integer[] NOT NULL,
  copier_table_depth text NOT NULL,
  currency text NOT NULL,
  page_size integer,
  pagination_kind text,
  status text NOT NULL,
  serving_mode text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE public.leaderboard_ranks (
  id uuid NOT NULL,
  season_id text NOT NULL,
  source text NOT NULL,
  source_trader_id text NOT NULL,
  rank integer,
  arena_score numeric,
  roi numeric,
  pnl numeric,
  win_rate numeric,
  max_drawdown numeric,
  score_completeness text,
  metrics_estimated boolean,
  is_outlier boolean,
  computed_at timestamptz,
  rank_change integer,
  is_new boolean,
  PRIMARY KEY (id, season_id),
  UNIQUE (season_id, source, source_trader_id)
) PARTITION BY LIST (season_id);
CREATE TABLE public.leaderboard_ranks_7d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('7D');
CREATE TABLE public.leaderboard_ranks_30d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('30D');
CREATE TABLE public.leaderboard_ranks_90d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('90D');

CREATE TABLE public.leaderboard_source_freshness (
  season_id text NOT NULL,
  source text NOT NULL,
  source_as_of timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (season_id, source)
);

CREATE TABLE public.leaderboard_count_cache (
  season_id text NOT NULL,
  source text NOT NULL,
  total_count integer NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (season_id, source)
);

CREATE TABLE arena.leaderboard_snapshots (id bigint PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE arena.leaderboard_entries (id bigint PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE arena.traders (id bigint PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE arena.trader_stats (id bigint PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE arena.trader_series (id bigint PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE arena.raw_captures (id bigint PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE arena.trader_position_history (id bigint PRIMARY KEY, payload jsonb NOT NULL);

CREATE FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  p_rank public.leaderboard_ranks,
  p_observed_at timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT COALESCE(
    (p_rank).score_completeness IS NOT DISTINCT FROM 'full'
    AND (p_rank).metrics_estimated IS NOT DISTINCT FROM false
    AND (p_rank).is_outlier IS NOT TRUE
    AND (p_rank).arena_score > 0
    AND (p_rank).roi IS NOT NULL
    AND (p_rank).pnl IS NOT NULL
    AND (p_rank).win_rate IS NOT NULL
    AND (p_rank).max_drawdown IS NOT NULL
    AND (p_rank).computed_at >= p_observed_at - interval '48 hours',
    false
  );
$function$;

CREATE FUNCTION public.arena_freshness_expected_sources()
RETURNS TABLE (
  registry_slug text,
  filter_source text,
  exchange_name text,
  season_id text
)
LANGUAGE sql
STABLE
AS $function$
  SELECT
    source.slug,
    COALESCE(NULLIF(pg_catalog.btrim(source.meta->>'legacy_platform'), ''), source.slug),
    exchange.name,
    timeframe.day_count::text || 'D'
  FROM arena.sources AS source
  JOIN arena.exchanges AS exchange ON exchange.id = source.exchange_id
  CROSS JOIN LATERAL pg_catalog.unnest(
    source.timeframes_native || source.timeframes_derived
  ) AS timeframe(day_count)
  WHERE source.status = 'active'
    AND source.serving_mode = 'serving'
    AND timeframe.day_count IN (7, 30, 90);
$function$;

CREATE FUNCTION public.rerank_public_eligible_leaderboard(p_season_id text)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
  v_updated integer;
BEGIN
  IF p_season_id <> ALL (ARRAY['7D', '30D', '90D']::text[]) THEN
    RAISE EXCEPTION 'invalid season';
  END IF;
  LOCK TABLE arena.sources, arena.exchanges IN SHARE MODE;
  LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE;
  WITH authority AS MATERIALIZED (
    SELECT DISTINCT expected.filter_source AS source
    FROM public.arena_freshness_expected_sources() AS expected
    WHERE expected.season_id = p_season_id
  ), classified AS MATERIALIZED (
    SELECT
      rank_row.id,
      rank_row.season_id,
      rank_row.arena_score,
      authority.source IS NOT NULL
        AND arena.leaderboard_rank_row_is_public_eligible(
          rank_row,
          pg_catalog.transaction_timestamp()
        ) AS eligible
    FROM public.leaderboard_ranks AS rank_row
    LEFT JOIN authority ON authority.source = rank_row.source
    WHERE rank_row.season_id = p_season_id
  ), ordered AS MATERIALIZED (
    SELECT
      classified.id,
      classified.season_id,
      pg_catalog.row_number() OVER (
        ORDER BY classified.arena_score DESC NULLS LAST, classified.id
      )::integer AS expected_rank
    FROM classified
    WHERE classified.eligible
  )
  UPDATE public.leaderboard_ranks AS rank_row
  SET
    rank = ordered.expected_rank,
    rank_change = NULL,
    is_new = false
  FROM classified
  LEFT JOIN ordered
    ON ordered.id = classified.id
   AND ordered.season_id = classified.season_id
  WHERE rank_row.id = classified.id
    AND rank_row.season_id = classified.season_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END
$function$;

CREATE FUNCTION public.refresh_public_rank_count_cache_for_seasons(p_season_ids text[])
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  LOCK TABLE public.leaderboard_ranks IN SHARE MODE;
  LOCK TABLE public.leaderboard_count_cache IN SHARE ROW EXCLUSIVE MODE;
  DELETE FROM public.leaderboard_count_cache
  WHERE season_id = ANY (p_season_ids);
  INSERT INTO public.leaderboard_count_cache (season_id, source, total_count, updated_at)
  SELECT season_id, '_all', pg_catalog.count(*)::integer, pg_catalog.statement_timestamp()
  FROM public.leaderboard_ranks
  WHERE season_id = ANY (p_season_ids)
    AND arena_score > 10 AND is_outlier IS NOT TRUE
  GROUP BY season_id
  UNION ALL
  SELECT season_id, source, pg_catalog.count(*)::integer, pg_catalog.statement_timestamp()
  FROM public.leaderboard_ranks
  WHERE season_id = ANY (p_season_ids)
    AND arena_score > 10 AND is_outlier IS NOT TRUE
  GROUP BY season_id, source
  UNION ALL
  SELECT season_id, '_all_gt0', pg_catalog.count(*)::integer, pg_catalog.statement_timestamp()
  FROM public.leaderboard_ranks
  WHERE season_id = ANY (p_season_ids)
    AND rank IS NOT NULL AND arena_score > 0 AND is_outlier IS NOT TRUE
  GROUP BY season_id
  UNION ALL
  SELECT season_id, source || '_gt0', pg_catalog.count(*)::integer, pg_catalog.statement_timestamp()
  FROM public.leaderboard_ranks
  WHERE season_id = ANY (p_season_ids)
    AND rank IS NOT NULL AND arena_score > 0 AND is_outlier IS NOT TRUE
  GROUP BY season_id, source;
END
$function$;

INSERT INTO arena.exchanges VALUES
  (1, 'bingx', 'BingX'),
  (2, 'safe', 'Safe Exchange');

INSERT INTO arena.sources VALUES
  (10, 'bingx_futures', 1, 'futures', 'human', 'bingx', ARRAY[7,30,90], '{}', 'full', 'USDT', 12, 'numeric', 'active', 'serving', '{"boardKey":"futures","preserve":"future"}'),
  (11, 'bingx_spot', 1, 'spot', 'human', 'bingx', ARRAY[7,30,90], '{}', 'full', 'USDT', 12, 'numeric', 'active', 'shadow', '{"boardKey":"spot","preserve":"spot"}'),
  (20, 'safe', 2, 'futures', 'human', 'safe', ARRAY[7,30,90], '{}', 'full', 'USDT', 20, 'numeric', 'active', 'serving', '{"legacy_platform":"safe"}');

WITH seasons(season_id) AS (
  VALUES ('7D'::text), ('30D'::text), ('90D'::text)
), templates(source, trader, score, completeness, initial_rank) AS (
  VALUES
    ('bingx'::text, 'future-legacy'::text, 99::numeric, 'full'::text, 1),
    ('bingx_futures', 'future-fallback', 98::numeric, 'full', 2),
    ('bingx_spot', 'spot', 97::numeric, 'full', 3),
    ('safe', 'safe-a', 90::numeric, 'full', 4),
    ('safe', 'safe-b', 80::numeric, 'full', 5),
    ('safe', 'safe-partial', 70::numeric, 'partial', 6)
), numbered AS (
  SELECT
    seasons.season_id,
    templates.*,
    pg_catalog.row_number() OVER (
      ORDER BY seasons.season_id, templates.source, templates.trader
    ) AS row_id
  FROM seasons CROSS JOIN templates
)
INSERT INTO public.leaderboard_ranks (
  id, season_id, source, source_trader_id, rank, arena_score,
  roi, pnl, win_rate, max_drawdown, score_completeness,
  metrics_estimated, is_outlier, computed_at, rank_change, is_new
)
SELECT
  (
    '00000000-0000-0000-0000-' ||
    pg_catalog.lpad(numbered.row_id::text, 12, '0')
  )::uuid,
  numbered.season_id,
  numbered.source,
  numbered.trader,
  numbered.initial_rank,
  numbered.score,
  20, 100, 60, 10, numbered.completeness,
  false, false, pg_catalog.statement_timestamp(), 4, true
FROM numbered;

INSERT INTO public.leaderboard_source_freshness (
  season_id, source, source_as_of, recorded_at
)
SELECT season.season_id, source.source, pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp()
FROM (VALUES ('7D'::text), ('30D'::text), ('90D'::text)) AS season(season_id)
CROSS JOIN (VALUES ('bingx'::text), ('bingx_futures'), ('bingx_spot'), ('safe')) AS source(source);

SELECT public.refresh_public_rank_count_cache_for_seasons(
  ARRAY['7D', '30D', '90D']::text[]
);

INSERT INTO arena.leaderboard_snapshots VALUES (1, '{"source":"bingx"}'), (2, '{"source":"safe"}');
INSERT INTO arena.leaderboard_entries VALUES (1, '{"rank":1}'), (2, '{"rank":2}');
INSERT INTO arena.traders VALUES (1, '{"id":"bingx"}'), (2, '{"id":"safe"}');
INSERT INTO arena.trader_stats VALUES (1, '{"roi":20}'), (2, '{"roi":10}');
INSERT INTO arena.trader_series VALUES (1, '{"point":1}'), (2, '{"point":2}');
INSERT INTO arena.raw_captures VALUES (1, '{"raw":"bingx"}'), (2, '{"raw":"safe"}');
INSERT INTO arena.trader_position_history VALUES (1, '{"position":"bingx"}'), (2, '{"position":"safe"}');
SQL
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -k '$SOCKET_DIR' -p $PORT -c listen_addresses=''" -w start >/dev/null

psql_postgres -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
SQL

# A writer that commits while the migration waits on its first registry lock
# must be visible to the lock-after-wait READ COMMITTED snapshot. This is the
# exact stale-snapshot regression: rank, freshness, and count rows all arrive
# after earlier dependency/DDL statements but before mutable-table locks.
setup_case concurrency_case
psql_db concurrency_case -q -c "
  DELETE FROM public.leaderboard_source_freshness
  WHERE season_id='7D' AND source='bingx_futures';
  DELETE FROM public.leaderboard_count_cache
  WHERE season_id='7D' AND source='bingx_futures_gt0';"
(
  psql_db concurrency_case -q <<'SQL'
SET application_name = 'bingx-lock-writer';
BEGIN;
UPDATE arena.sources SET meta=meta WHERE slug='bingx_futures';
INSERT INTO public.leaderboard_ranks (
  id, season_id, source, source_trader_id, rank, arena_score, roi, pnl,
  win_rate, max_drawdown, score_completeness, metrics_estimated, is_outlier,
  computed_at, rank_change, is_new
) VALUES (
  '40000000-0000-0000-0000-000000000001', '7D', 'bingx_futures',
  'lock-wait-late', 7, 77, 20, 100, 60, 10, 'full', false, false,
  statement_timestamp(), 1, true
);
INSERT INTO public.leaderboard_source_freshness
VALUES ('7D','bingx_futures',statement_timestamp(),statement_timestamp());
INSERT INTO public.leaderboard_count_cache
VALUES ('7D','bingx_futures_gt0',1,statement_timestamp());
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
) &
WRITER_PID=$!
WRITER_READY=''
for _ in {1..80}; do
  WRITER_READY="$(
    psql_db concurrency_case -Atqc "
      SELECT count(*)
      FROM pg_catalog.pg_stat_activity
      WHERE application_name='bingx-lock-writer'
        AND wait_event='PgSleep';"
  )"
  [[ "$WRITER_READY" == '1' ]] && break
  sleep 0.05
done
assert_equal 'concurrent writer reached lock hold' '1' "$WRITER_READY"
psql_db concurrency_case -q -f "$MIGRATION"
wait "$WRITER_PID"
assert_equal 'lock-wait row entered archive' '1' "$(
  psql_db concurrency_case -Atqc "
    SELECT count(*) FROM arena.bingx_rank_quarantine_rows
    WHERE source_trader_id='lock-wait-late';"
)"
assert_equal 'lock-wait surfaces cleaned' '0' "$(
  psql_db concurrency_case -Atqc "
    SELECT
      (SELECT count(*) FROM public.leaderboard_ranks WHERE source IN ('bingx','bingx_futures','bingx_spot'))
      + (SELECT count(*) FROM public.leaderboard_source_freshness WHERE source IN ('bingx','bingx_futures','bingx_spot'))
      + (SELECT count(*) FROM public.leaderboard_count_cache WHERE source IN ('bingx','bingx_futures','bingx_spot','bingx_gt0','bingx_futures_gt0','bingx_spot_gt0'));"
)"

setup_case success_case
PRESERVATION_BEFORE="$(preservation_fingerprint success_case)"
psql_db success_case -q -f "$MIGRATION"
PRESERVATION_AFTER="$(preservation_fingerprint success_case)"
assert_equal 'source evidence preservation_fingerprint' "$PRESERVATION_BEFORE" "$PRESERVATION_AFTER"

assert_equal 'archived rank count' '9' "$(
  psql_db success_case -Atqc "SELECT archived_rank_count FROM arena.bingx_rank_quarantine_batches"
)"
assert_equal 'archived row count' '9' "$(
  psql_db success_case -Atqc "SELECT count(*) FROM arena.bingx_rank_quarantine_rows"
)"
assert_equal 'archive SHA-256 length' '64' "$(
  psql_db success_case -Atqc "SELECT length(archived_rank_sha256) FROM arena.bingx_rank_quarantine_batches"
)"
assert_equal 'typed archive reconstruction' '9' "$(
  psql_db success_case -Atqc "
    SELECT count(*)
    FROM arena.bingx_rank_quarantine_rows AS archive
    CROSS JOIN LATERAL pg_catalog.jsonb_populate_record(
      NULL::public.leaderboard_ranks,
      archive.row_data
    ) AS restored
    WHERE restored.id::text = archive.live_rank_id
      AND restored.season_id = archive.season_id
      AND restored.source = archive.source
      AND restored.source_trader_id = archive.source_trader_id;"
)"
assert_equal 'active shadow sources' '2' "$(
  psql_db success_case -Atqc "
    SELECT count(*) FROM arena.sources
    WHERE slug IN ('bingx_futures','bingx_spot')
      AND status='active' AND serving_mode='shadow'
      AND meta->>'rank_visibility_contract'='bingx-ranking-quarantine@1';"
)"
assert_equal 'remaining BingX ranks' '0' "$(
  psql_db success_case -Atqc "SELECT count(*) FROM public.leaderboard_ranks WHERE source IN ('bingx','bingx_futures','bingx_spot');"
)"
assert_equal 'remaining BingX freshness' '0' "$(
  psql_db success_case -Atqc "SELECT count(*) FROM public.leaderboard_source_freshness WHERE source IN ('bingx','bingx_futures','bingx_spot');"
)"
assert_equal 'remaining BingX cache' '0' "$(
  psql_db success_case -Atqc "SELECT count(*) FROM public.leaderboard_count_cache WHERE source IN ('bingx','bingx_futures','bingx_spot','bingx_gt0','bingx_futures_gt0','bingx_spot_gt0');"
)"
assert_equal 'eligible ranks and partial quarantine' '9' "$(
  psql_db success_case -Atqc "
    SELECT count(*)
    FROM public.leaderboard_ranks
    WHERE (source_trader_id='safe-a' AND rank=1 AND rank_change IS NULL AND is_new=false)
       OR (source_trader_id='safe-b' AND rank=2 AND rank_change IS NULL AND is_new=false)
       OR (source_trader_id='safe-partial' AND rank IS NULL AND rank_change IS NULL AND is_new=false);"
)"
assert_equal 'rank-authoritative cache' '3' "$(
  psql_db success_case -Atqc "
    SELECT count(*) FROM public.leaderboard_count_cache
    WHERE source='_all_gt0' AND total_count=2;"
)"

# A normal replay must neither rewrite the archive nor erase movement that was
# recorded after the administrative rerank.
psql_db success_case -q -c "
  UPDATE public.leaderboard_ranks
  SET rank_change=7, is_new=true
  WHERE season_id='7D' AND source_trader_id='safe-a';"
ARCHIVE_BEFORE_REPLAY="$(
  psql_db success_case -Atqc "SELECT archived_rank_sha256 || '|' || archived_rank_count FROM arena.bingx_rank_quarantine_batches"
)"
psql_db success_case -q -f "$MIGRATION"
assert_equal 'archive replay stability' "$ARCHIVE_BEFORE_REPLAY" "$(
  psql_db success_case -Atqc "SELECT archived_rank_sha256 || '|' || archived_rank_count FROM arena.bingx_rank_quarantine_batches"
)"
assert_equal 'replay movement preservation' '7|true' "$(
  psql_db success_case -Atqc "SELECT rank_change::text || '|' || is_new::text FROM public.leaderboard_ranks WHERE season_id='7D' AND source_trader_id='safe-a'"
)"

for source_slug in bingx_futures bingx_spot; do
  assert_sql_fails success_case "source promotion guard $source_slug" \
    "UPDATE arena.sources SET serving_mode='serving' WHERE slug='$source_slug';"
done

for rank_source in bingx bingx_futures bingx_spot; do
  assert_sql_fails success_case "delayed writer rank guard $rank_source" \
    "INSERT INTO public.leaderboard_ranks (id,season_id,source,source_trader_id) VALUES ('10000000-0000-0000-0000-000000000001','7D','$rank_source','late-$rank_source');"
  assert_sql_fails success_case "delayed writer freshness guard $rank_source" \
    "INSERT INTO public.leaderboard_source_freshness VALUES ('7D','$rank_source',statement_timestamp(),statement_timestamp());"
done
for cache_source in bingx bingx_futures bingx_spot bingx_gt0 bingx_futures_gt0 bingx_spot_gt0; do
  assert_sql_fails success_case "delayed writer count guard $cache_source" \
    "INSERT INTO public.leaderboard_count_cache VALUES ('7D','$cache_source',1,statement_timestamp());"
done

psql_db success_case -q -c "CREATE TABLE public.leaderboard_ranks_1d PARTITION OF public.leaderboard_ranks FOR VALUES IN ('1D');"
for rank_source in bingx bingx_futures bingx_spot; do
  assert_sql_fails success_case "new partition delayed writer $rank_source" \
    "INSERT INTO public.leaderboard_ranks (id,season_id,source,source_trader_id) VALUES ('20000000-0000-0000-0000-000000000001','1D','$rank_source','partition-$rank_source');"
done

# Same-named weak guards are not accepted. Replay replaces and validates all
# four exact parent guards before it commits.
psql_db success_case -q <<'SQL'
ALTER TABLE arena.sources DROP CONSTRAINT sources_block_unverified_bingx_serving;
ALTER TABLE arena.sources ADD CONSTRAINT sources_block_unverified_bingx_serving CHECK (true);
ALTER TABLE public.leaderboard_ranks DROP CONSTRAINT leaderboard_ranks_block_unverified_bingx;
ALTER TABLE public.leaderboard_ranks ADD CONSTRAINT leaderboard_ranks_block_unverified_bingx CHECK (true);
ALTER TABLE public.leaderboard_source_freshness DROP CONSTRAINT leaderboard_freshness_block_unverified_bingx;
ALTER TABLE public.leaderboard_source_freshness ADD CONSTRAINT leaderboard_freshness_block_unverified_bingx CHECK (true);
ALTER TABLE public.leaderboard_count_cache DROP CONSTRAINT leaderboard_count_cache_block_unverified_bingx;
ALTER TABLE public.leaderboard_count_cache ADD CONSTRAINT leaderboard_count_cache_block_unverified_bingx CHECK (true);
SQL
psql_db success_case -q -f "$MIGRATION"
assert_equal 'constraint tamper repair' '4' "$(
  psql_db success_case -Atqc "
    SELECT count(*) FROM pg_catalog.pg_constraint
    WHERE (
      (conrelid='arena.sources'::regclass AND conname='sources_block_unverified_bingx_serving')
      OR (conrelid='public.leaderboard_ranks'::regclass AND conname='leaderboard_ranks_block_unverified_bingx')
      OR (conrelid='public.leaderboard_source_freshness'::regclass AND conname='leaderboard_freshness_block_unverified_bingx')
      OR (conrelid='public.leaderboard_count_cache'::regclass AND conname='leaderboard_count_cache_block_unverified_bingx')
    ) AND convalidated AND pg_catalog.pg_get_constraintdef(oid) <> 'CHECK (true)';"
)"

# If a guard was removed and a stale row appeared, replay fails closed instead
# of silently extending the completed archive ledger.
psql_postgres -q -c "CREATE DATABASE stale_replay TEMPLATE success_case;"
psql_db stale_replay -q -c "
  ALTER TABLE public.leaderboard_ranks DROP CONSTRAINT leaderboard_ranks_block_unverified_bingx;
  INSERT INTO public.leaderboard_ranks (id,season_id,source,source_trader_id)
  VALUES ('30000000-0000-0000-0000-000000000001','7D','bingx','stale');"
assert_migration_fails stale_replay 'stale replay' \
  'completed BingX quarantine replay found republished rank surfaces'
assert_equal 'stale replay preserved investigation row' '1' "$(
  psql_db stale_replay -Atqc "SELECT count(*) FROM public.leaderboard_ranks WHERE source='bingx'"
)"
assert_equal 'stale replay did not extend archive' '9' "$(
  psql_db stale_replay -Atqc "SELECT archived_rank_count FROM arena.bingx_rank_quarantine_batches"
)"

# Alias drift fails before any source or public surface mutation.
setup_case alias_drift
psql_db alias_drift -q -c "UPDATE arena.sources SET meta=jsonb_set(meta,'{legacy_platform}','\"wrong\"') WHERE slug='bingx_futures';"
ALIAS_SURFACE_BEFORE="$(rank_surface_fingerprint alias_drift)"
assert_migration_fails alias_drift 'alias drift' \
  'BingX source dimensions or public aliases drifted'
assert_equal 'alias drift rank surface rollback' "$ALIAS_SURFACE_BEFORE" "$(rank_surface_fingerprint alias_drift)"
assert_equal 'alias drift archive DDL rollback' '' "$(
  psql_db alias_drift -Atqc "SELECT pg_catalog.to_regclass('arena.bingx_rank_quarantine_batches')::text"
)"

# A failed count refresh occurs after archive/source/rank/freshness mutations;
# the outer transaction must roll every one of them back.
setup_case rollback_case
ROLLBACK_EVIDENCE_BEFORE="$(preservation_fingerprint rollback_case)"
ROLLBACK_SURFACE_BEFORE="$(rank_surface_fingerprint rollback_case)"
ROLLBACK_SOURCE_BEFORE="$(
  psql_db rollback_case -Atqc "SELECT string_agg(slug || '|' || serving_mode || '|' || meta::text, E'\\n' ORDER BY slug) FROM arena.sources"
)"
psql_db rollback_case -q <<'SQL'
CREATE OR REPLACE FUNCTION public.refresh_public_rank_count_cache_for_seasons(
  p_season_ids text[]
)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'forced cache failure for rollback proof';
END
$function$;
SQL
assert_migration_fails rollback_case 'rollback' 'forced cache failure for rollback proof'
assert_equal 'rollback evidence' "$ROLLBACK_EVIDENCE_BEFORE" "$(preservation_fingerprint rollback_case)"
assert_equal 'rollback public surfaces' "$ROLLBACK_SURFACE_BEFORE" "$(rank_surface_fingerprint rollback_case)"
assert_equal 'rollback source state' "$ROLLBACK_SOURCE_BEFORE" "$(
  psql_db rollback_case -Atqc "SELECT string_agg(slug || '|' || serving_mode || '|' || meta::text, E'\\n' ORDER BY slug) FROM arena.sources"
)"
assert_equal 'rollback archive DDL' '' "$(
  psql_db rollback_case -Atqc "SELECT pg_catalog.to_regclass('arena.bingx_rank_quarantine_batches')::text"
)"

echo 'BingX rank authority quarantine PG17 proof passed'
