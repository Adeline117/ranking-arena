-- PREPARE ONLY: archive every serving/materialized row affected by the GMX
-- PnL-contract-v2 cutover. This migration deliberately changes no serving
-- value, source contract, snapshot verdict, public rank, or count cache row.
-- All GMX writers and compute-leaderboard must remain stopped from before this
-- transaction until 20260715232500 reaches COMPLETE.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '240s';
SET LOCAL TIME ZONE 'UTC';

CREATE TABLE IF NOT EXISTS arena.data_contract_quarantine_batches (
  batch_id text PRIMARY KEY,
  source_slug text NOT NULL,
  contract_version integer NOT NULL,
  reason text NOT NULL,
  state text NOT NULL CHECK (state IN ('PREPARED', 'COMPLETE')),
  archive_counts jsonb NOT NULL,
  archive_digests jsonb NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  cutover_at timestamptz,
  cutover_counts jsonb,
  CHECK (
    (state = 'PREPARED' AND cutover_at IS NULL AND cutover_counts IS NULL)
    OR
    (state = 'COMPLETE' AND cutover_at IS NOT NULL AND cutover_counts IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS arena.source_registry_quarantine (
  batch_id text NOT NULL,
  source_slug text NOT NULL,
  source_id smallint NOT NULL,
  row_data jsonb NOT NULL,
  reason text NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (batch_id, source_id)
);

CREATE TABLE IF NOT EXISTS arena.leaderboard_snapshots_quarantine (
  batch_id text NOT NULL,
  source_slug text NOT NULL,
  snapshot_id bigint NOT NULL,
  row_data jsonb NOT NULL,
  reason text NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (batch_id, snapshot_id)
);

CREATE TABLE IF NOT EXISTS arena.trader_stats_quarantine (
  batch_id text NOT NULL,
  source_slug text NOT NULL,
  trader_id bigint NOT NULL,
  timeframe smallint NOT NULL,
  row_data jsonb NOT NULL,
  reason text NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (batch_id, trader_id, timeframe)
);

CREATE TABLE IF NOT EXISTS arena.trader_series_quarantine (
  batch_id text NOT NULL,
  source_slug text NOT NULL,
  original_table text NOT NULL CHECK (
    original_table IN ('trader_series', 'trader_series_weekly')
  ),
  trader_id bigint NOT NULL,
  timeframe smallint NOT NULL,
  metric text NOT NULL,
  point_at timestamptz NOT NULL,
  value numeric NOT NULL,
  currency text NOT NULL,
  reason text NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (
    batch_id, original_table, trader_id, timeframe, metric, point_at
  )
);

CREATE TABLE IF NOT EXISTS arena.leaderboard_ranks_quarantine (
  batch_id text NOT NULL,
  source_slug text NOT NULL,
  rank_id bigint NOT NULL,
  season_id text NOT NULL,
  source_trader_id text NOT NULL,
  row_data jsonb NOT NULL,
  reason text NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (batch_id, rank_id, season_id)
);

CREATE TABLE IF NOT EXISTS arena.leaderboard_count_cache_quarantine (
  batch_id text NOT NULL,
  source_slug text NOT NULL,
  season_id text NOT NULL,
  cache_source text NOT NULL,
  row_data jsonb NOT NULL,
  reason text NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (batch_id, season_id, cache_source)
);

ALTER TABLE arena.data_contract_quarantine_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.source_registry_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_snapshots_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.trader_stats_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.trader_series_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_ranks_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_count_cache_quarantine ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  arena.data_contract_quarantine_batches,
  arena.source_registry_quarantine,
  arena.leaderboard_snapshots_quarantine,
  arena.trader_stats_quarantine,
  arena.trader_series_quarantine,
  arena.leaderboard_ranks_quarantine,
  arena.leaderboard_count_cache_quarantine
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  arena.data_contract_quarantine_batches,
  arena.source_registry_quarantine,
  arena.leaderboard_snapshots_quarantine,
  arena.trader_stats_quarantine,
  arena.trader_series_quarantine,
  arena.leaderboard_ranks_quarantine,
  arena.leaderboard_count_cache_quarantine
TO service_role;

COMMENT ON TABLE arena.data_contract_quarantine_batches IS
  'Private PREPARED/COMPLETE ledger for replay-safe data-contract cutovers.';
COMMENT ON TABLE arena.source_registry_quarantine IS
  'Private full-row source registry archive for audited data-contract cutovers.';
COMMENT ON TABLE arena.leaderboard_snapshots_quarantine IS
  'Private full-row leaderboard snapshot archive for audited cutovers.';
COMMENT ON TABLE arena.trader_stats_quarantine IS
  'Private full-row trader_stats archive for audited cleanup batches.';
COMMENT ON TABLE arena.trader_series_quarantine IS
  'Private reversible archive of serving series removed by audited cleanup batches.';
COMMENT ON TABLE arena.leaderboard_ranks_quarantine IS
  'Private full-row public rank archive keyed independently of live ID type drift.';
COMMENT ON TABLE arena.leaderboard_count_cache_quarantine IS
  'Private full-row archive of source and aggregate count-cache rows invalidated by a cutover.';

-- Serialize this batch and share the exact lock used by the board/series
-- publisher. Table locks then fence profile, ranking, and cache writers that do
-- not participate in the publisher advisory protocol.
SELECT pg_advisory_xact_lock(hashtextextended('20260715_gmx_pnl_contract_v2', 0));
SELECT pg_advisory_xact_lock(
  hashtextextended('arena.publish-board-series:' || id::text, 0)
)
FROM arena.sources
WHERE slug = 'gmx';

LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.leaderboard_snapshots IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.trader_stats IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.trader_series_weekly IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.trader_series IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.leaderboard_count_cache IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  v_batch_id constant text := '20260715_gmx_pnl_contract_v2';
  v_source_slug constant text := 'gmx';
  v_contract_version constant integer := 2;
  v_reason constant text := 'pre_v2_mixed_realized_and_total_mtm_pnl_contract';
  v_source_id smallint;
  v_source_count bigint;
  v_live_counts jsonb;
  v_live_digests jsonb;
  v_archive_counts jsonb;
  v_archive_digests jsonb;
  v_batch arena.data_contract_quarantine_batches%ROWTYPE;
BEGIN
  SELECT min(id), count(*)
  INTO v_source_id, v_source_count
  FROM arena.sources
  WHERE slug = v_source_slug;

  IF v_source_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one gmx source row, found %', v_source_count;
  END IF;

  SELECT jsonb_build_object(
    'source_registry', (
      SELECT count(*) FROM arena.sources WHERE id = v_source_id
    ),
    'leaderboard_snapshots', (
      SELECT count(*) FROM arena.leaderboard_snapshots WHERE source_id = v_source_id
    ),
    'trader_stats', (
      SELECT count(*)
      FROM arena.trader_stats AS stats
      JOIN arena.traders AS trader ON trader.id = stats.trader_id
      WHERE trader.source_id = v_source_id
    ),
    'trader_series', (
      SELECT count(*)
      FROM arena.trader_series AS series
      JOIN arena.traders AS trader ON trader.id = series.trader_id
      WHERE trader.source_id = v_source_id AND series.metric = 'pnl'
    ),
    'trader_series_weekly', (
      SELECT count(*)
      FROM arena.trader_series_weekly AS series
      JOIN arena.traders AS trader ON trader.id = series.trader_id
      WHERE trader.source_id = v_source_id AND series.metric = 'pnl'
    ),
    'leaderboard_ranks', (
      SELECT count(*) FROM public.leaderboard_ranks WHERE source = v_source_slug
    ),
    'leaderboard_count_cache', (
      SELECT count(*)
      FROM public.leaderboard_count_cache
      WHERE season_id IN ('7D', '30D', '90D')
        AND source IN ('gmx', 'gmx_gt0', '_all', '_all_gt0')
    )
  )
  INTO v_live_counts;

  SELECT jsonb_build_object(
    'source_registry', (
      SELECT md5(COALESCE(string_agg(to_jsonb(source_row)::text, E'\n' ORDER BY source_row.id), ''))
      FROM arena.sources AS source_row
      WHERE source_row.id = v_source_id
    ),
    'leaderboard_snapshots', (
      SELECT md5(COALESCE(string_agg(to_jsonb(snapshot)::text, E'\n' ORDER BY snapshot.id), ''))
      FROM arena.leaderboard_snapshots AS snapshot
      WHERE snapshot.source_id = v_source_id
    ),
    'trader_stats', (
      SELECT md5(COALESCE(string_agg(to_jsonb(stats)::text, E'\n'
        ORDER BY stats.trader_id, stats.timeframe), ''))
      FROM arena.trader_stats AS stats
      JOIN arena.traders AS trader ON trader.id = stats.trader_id
      WHERE trader.source_id = v_source_id
    ),
    'trader_series', (
      SELECT md5(COALESCE(string_agg(
        jsonb_build_array(
          'trader_series', series.trader_id, series.timeframe, series.metric,
          series.ts, series.value, series.currency
        )::text,
        E'\n' ORDER BY series.trader_id, series.timeframe, series.metric, series.ts
      ), ''))
      FROM arena.trader_series AS series
      JOIN arena.traders AS trader ON trader.id = series.trader_id
      WHERE trader.source_id = v_source_id AND series.metric = 'pnl'
    ),
    'trader_series_weekly', (
      SELECT md5(COALESCE(string_agg(
        jsonb_build_array(
          'trader_series_weekly', series.trader_id, series.timeframe, series.metric,
          series.week_start::timestamptz, series.value, series.currency
        )::text,
        E'\n' ORDER BY series.trader_id, series.timeframe, series.metric, series.week_start
      ), ''))
      FROM arena.trader_series_weekly AS series
      JOIN arena.traders AS trader ON trader.id = series.trader_id
      WHERE trader.source_id = v_source_id AND series.metric = 'pnl'
    ),
    'leaderboard_ranks', (
      SELECT md5(COALESCE(string_agg(to_jsonb(rank_row)::text, E'\n'
        ORDER BY rank_row.id, rank_row.season_id), ''))
      FROM public.leaderboard_ranks AS rank_row
      WHERE rank_row.source = v_source_slug
    ),
    'leaderboard_count_cache', (
      SELECT md5(COALESCE(string_agg(to_jsonb(cache_row)::text, E'\n'
        ORDER BY cache_row.season_id, cache_row.source), ''))
      FROM public.leaderboard_count_cache AS cache_row
      WHERE cache_row.season_id IN ('7D', '30D', '90D')
        AND cache_row.source IN ('gmx', 'gmx_gt0', '_all', '_all_gt0')
    )
  )
  INTO v_live_digests;

  SELECT jsonb_build_object(
    'source_registry', (
      SELECT count(*) FROM arena.source_registry_quarantine WHERE batch_id = v_batch_id
    ),
    'leaderboard_snapshots', (
      SELECT count(*) FROM arena.leaderboard_snapshots_quarantine WHERE batch_id = v_batch_id
    ),
    'trader_stats', (
      SELECT count(*) FROM arena.trader_stats_quarantine WHERE batch_id = v_batch_id
    ),
    'trader_series', (
      SELECT count(*) FROM arena.trader_series_quarantine
      WHERE batch_id = v_batch_id AND original_table = 'trader_series'
    ),
    'trader_series_weekly', (
      SELECT count(*) FROM arena.trader_series_quarantine
      WHERE batch_id = v_batch_id AND original_table = 'trader_series_weekly'
    ),
    'leaderboard_ranks', (
      SELECT count(*) FROM arena.leaderboard_ranks_quarantine WHERE batch_id = v_batch_id
    ),
    'leaderboard_count_cache', (
      SELECT count(*) FROM arena.leaderboard_count_cache_quarantine WHERE batch_id = v_batch_id
    )
  )
  INTO v_archive_counts;

  SELECT jsonb_build_object(
    'source_registry', (
      SELECT md5(COALESCE(string_agg(row_data::text, E'\n' ORDER BY source_id), ''))
      FROM arena.source_registry_quarantine WHERE batch_id = v_batch_id
    ),
    'leaderboard_snapshots', (
      SELECT md5(COALESCE(string_agg(row_data::text, E'\n' ORDER BY snapshot_id), ''))
      FROM arena.leaderboard_snapshots_quarantine WHERE batch_id = v_batch_id
    ),
    'trader_stats', (
      SELECT md5(COALESCE(string_agg(row_data::text, E'\n' ORDER BY trader_id, timeframe), ''))
      FROM arena.trader_stats_quarantine WHERE batch_id = v_batch_id
    ),
    'trader_series', (
      SELECT md5(COALESCE(string_agg(
        jsonb_build_array(
          original_table, trader_id, timeframe, metric, point_at, value, currency
        )::text,
        E'\n' ORDER BY trader_id, timeframe, metric, point_at
      ), ''))
      FROM arena.trader_series_quarantine
      WHERE batch_id = v_batch_id AND original_table = 'trader_series'
    ),
    'trader_series_weekly', (
      SELECT md5(COALESCE(string_agg(
        jsonb_build_array(
          original_table, trader_id, timeframe, metric, point_at, value, currency
        )::text,
        E'\n' ORDER BY trader_id, timeframe, metric, point_at
      ), ''))
      FROM arena.trader_series_quarantine
      WHERE batch_id = v_batch_id AND original_table = 'trader_series_weekly'
    ),
    'leaderboard_ranks', (
      SELECT md5(COALESCE(string_agg(row_data::text, E'\n' ORDER BY rank_id, season_id), ''))
      FROM arena.leaderboard_ranks_quarantine WHERE batch_id = v_batch_id
    ),
    'leaderboard_count_cache', (
      SELECT md5(COALESCE(string_agg(row_data::text, E'\n'
        ORDER BY season_id, cache_source), ''))
      FROM arena.leaderboard_count_cache_quarantine WHERE batch_id = v_batch_id
    )
  )
  INTO v_archive_digests;

  SELECT *
  INTO v_batch
  FROM arena.data_contract_quarantine_batches
  WHERE batch_id = v_batch_id;

  IF FOUND THEN
    IF v_batch.source_slug <> v_source_slug
       OR v_batch.contract_version <> v_contract_version
       OR v_batch.reason <> v_reason THEN
      RAISE EXCEPTION 'GMX batch identity mismatch for %', v_batch_id;
    END IF;
    IF v_batch.archive_counts <> v_archive_counts
       OR v_batch.archive_digests <> v_archive_digests THEN
      RAISE EXCEPTION 'GMX batch archive count/digest mismatch for %', v_batch_id;
    END IF;
    IF v_batch.state = 'PREPARED'
       AND (v_live_counts <> v_archive_counts OR v_live_digests <> v_archive_digests) THEN
      RAISE EXCEPTION
        'GMX live rows changed after PREPARE; keep writers stopped and re-audit batch %',
        v_batch_id;
    END IF;
    IF v_batch.state NOT IN ('PREPARED', 'COMPLETE') THEN
      RAISE EXCEPTION 'unknown GMX batch state % for %', v_batch.state, v_batch_id;
    END IF;
    RAISE NOTICE 'GMX batch % already %, archive verified', v_batch_id, v_batch.state;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_each_text(v_archive_counts) AS archived
    WHERE archived.value::bigint <> 0
  ) THEN
    RAISE EXCEPTION 'orphan/partial GMX archive exists without batch ledger %', v_batch_id;
  END IF;

  -- Fail closed on a materially different production population. A pristine
  -- database with no GMX serving rows remains migratable.
  IF (v_live_counts->>'leaderboard_snapshots')::bigint > 0
     OR (v_live_counts->>'trader_stats')::bigint > 0
     OR (v_live_counts->>'trader_series')::bigint > 0
     OR (v_live_counts->>'trader_series_weekly')::bigint > 0
     OR (v_live_counts->>'leaderboard_ranks')::bigint > 0 THEN
    IF NOT ((v_live_counts->>'leaderboard_snapshots')::bigint BETWEEN 400 AND 650)
       OR NOT ((v_live_counts->>'trader_stats')::bigint BETWEEN 500 AND 600)
       OR NOT ((v_live_counts->>'trader_series')::bigint BETWEEN 25000 AND 31000)
       OR NOT ((v_live_counts->>'trader_series_weekly')::bigint BETWEEN 700 AND 900)
       OR NOT ((v_live_counts->>'leaderboard_ranks')::bigint BETWEEN 75 AND 250)
       OR (v_live_counts->>'leaderboard_count_cache')::bigint NOT IN (9, 12)
       OR (SELECT count(*) FROM public.leaderboard_count_cache
           WHERE season_id IN ('7D', '30D', '90D') AND source = '_all') <> 3
       OR (SELECT count(*) FROM public.leaderboard_count_cache
           WHERE season_id IN ('7D', '30D', '90D') AND source = '_all_gt0') <> 3
       OR (SELECT count(*) FROM public.leaderboard_count_cache
           WHERE season_id IN ('7D', '30D', '90D') AND source = 'gmx') <> 3
       OR (SELECT count(*) FROM public.leaderboard_count_cache
           WHERE season_id IN ('7D', '30D', '90D') AND source = 'gmx_gt0') NOT IN (0, 3) THEN
      RAISE EXCEPTION 'unexpected GMX PREPARE population %, refusing archive', v_live_counts;
    END IF;
  END IF;

  INSERT INTO arena.source_registry_quarantine (
    batch_id, source_slug, source_id, row_data, reason
  )
  SELECT v_batch_id, v_source_slug, source_row.id, to_jsonb(source_row), v_reason
  FROM arena.sources AS source_row
  WHERE source_row.id = v_source_id;

  INSERT INTO arena.leaderboard_snapshots_quarantine (
    batch_id, source_slug, snapshot_id, row_data, reason
  )
  SELECT v_batch_id, v_source_slug, snapshot.id, to_jsonb(snapshot), v_reason
  FROM arena.leaderboard_snapshots AS snapshot
  WHERE snapshot.source_id = v_source_id;

  INSERT INTO arena.trader_stats_quarantine (
    batch_id, source_slug, trader_id, timeframe, row_data, reason
  )
  SELECT v_batch_id, v_source_slug, stats.trader_id, stats.timeframe, to_jsonb(stats), v_reason
  FROM arena.trader_stats AS stats
  JOIN arena.traders AS trader ON trader.id = stats.trader_id
  WHERE trader.source_id = v_source_id;

  INSERT INTO arena.trader_series_quarantine (
    batch_id, source_slug, original_table, trader_id, timeframe,
    metric, point_at, value, currency, reason
  )
  SELECT v_batch_id, v_source_slug, 'trader_series', series.trader_id,
         series.timeframe, series.metric, series.ts, series.value,
         series.currency, v_reason
  FROM arena.trader_series AS series
  JOIN arena.traders AS trader ON trader.id = series.trader_id
  WHERE trader.source_id = v_source_id AND series.metric = 'pnl';

  INSERT INTO arena.trader_series_quarantine (
    batch_id, source_slug, original_table, trader_id, timeframe,
    metric, point_at, value, currency, reason
  )
  SELECT v_batch_id, v_source_slug, 'trader_series_weekly', series.trader_id,
         series.timeframe, series.metric, series.week_start::timestamptz,
         series.value, series.currency, v_reason
  FROM arena.trader_series_weekly AS series
  JOIN arena.traders AS trader ON trader.id = series.trader_id
  WHERE trader.source_id = v_source_id AND series.metric = 'pnl';

  INSERT INTO arena.leaderboard_ranks_quarantine (
    batch_id, source_slug, rank_id, season_id, source_trader_id, row_data, reason
  )
  SELECT v_batch_id, v_source_slug, rank_row.id, rank_row.season_id,
         rank_row.source_trader_id, to_jsonb(rank_row), v_reason
  FROM public.leaderboard_ranks AS rank_row
  WHERE rank_row.source = v_source_slug;

  INSERT INTO arena.leaderboard_count_cache_quarantine (
    batch_id, source_slug, season_id, cache_source, row_data, reason
  )
  SELECT v_batch_id, v_source_slug, cache_row.season_id, cache_row.source,
         to_jsonb(cache_row), v_reason
  FROM public.leaderboard_count_cache AS cache_row
  WHERE cache_row.season_id IN ('7D', '30D', '90D')
    AND cache_row.source IN ('gmx', 'gmx_gt0', '_all', '_all_gt0');

  -- Recompute from the immutable archive; do not trust INSERT row counts alone.
  SELECT jsonb_build_object(
    'source_registry', (SELECT count(*) FROM arena.source_registry_quarantine WHERE batch_id = v_batch_id),
    'leaderboard_snapshots', (SELECT count(*) FROM arena.leaderboard_snapshots_quarantine WHERE batch_id = v_batch_id),
    'trader_stats', (SELECT count(*) FROM arena.trader_stats_quarantine WHERE batch_id = v_batch_id),
    'trader_series', (SELECT count(*) FROM arena.trader_series_quarantine WHERE batch_id = v_batch_id AND original_table = 'trader_series'),
    'trader_series_weekly', (SELECT count(*) FROM arena.trader_series_quarantine WHERE batch_id = v_batch_id AND original_table = 'trader_series_weekly'),
    'leaderboard_ranks', (SELECT count(*) FROM arena.leaderboard_ranks_quarantine WHERE batch_id = v_batch_id),
    'leaderboard_count_cache', (SELECT count(*) FROM arena.leaderboard_count_cache_quarantine WHERE batch_id = v_batch_id)
  ) INTO v_archive_counts;

  SELECT jsonb_build_object(
    'source_registry', (SELECT md5(COALESCE(string_agg(row_data::text, E'\n' ORDER BY source_id), '')) FROM arena.source_registry_quarantine WHERE batch_id = v_batch_id),
    'leaderboard_snapshots', (SELECT md5(COALESCE(string_agg(row_data::text, E'\n' ORDER BY snapshot_id), '')) FROM arena.leaderboard_snapshots_quarantine WHERE batch_id = v_batch_id),
    'trader_stats', (SELECT md5(COALESCE(string_agg(row_data::text, E'\n' ORDER BY trader_id, timeframe), '')) FROM arena.trader_stats_quarantine WHERE batch_id = v_batch_id),
    'trader_series', (SELECT md5(COALESCE(string_agg(jsonb_build_array(original_table, trader_id, timeframe, metric, point_at, value, currency)::text, E'\n' ORDER BY trader_id, timeframe, metric, point_at), '')) FROM arena.trader_series_quarantine WHERE batch_id = v_batch_id AND original_table = 'trader_series'),
    'trader_series_weekly', (SELECT md5(COALESCE(string_agg(jsonb_build_array(original_table, trader_id, timeframe, metric, point_at, value, currency)::text, E'\n' ORDER BY trader_id, timeframe, metric, point_at), '')) FROM arena.trader_series_quarantine WHERE batch_id = v_batch_id AND original_table = 'trader_series_weekly'),
    'leaderboard_ranks', (SELECT md5(COALESCE(string_agg(row_data::text, E'\n' ORDER BY rank_id, season_id), '')) FROM arena.leaderboard_ranks_quarantine WHERE batch_id = v_batch_id),
    'leaderboard_count_cache', (SELECT md5(COALESCE(string_agg(row_data::text, E'\n' ORDER BY season_id, cache_source), '')) FROM arena.leaderboard_count_cache_quarantine WHERE batch_id = v_batch_id)
  ) INTO v_archive_digests;

  IF v_archive_counts <> v_live_counts OR v_archive_digests <> v_live_digests THEN
    RAISE EXCEPTION
      'GMX PREPARE archive mismatch: live counts %, archive counts %, live digests %, archive digests %',
      v_live_counts, v_archive_counts, v_live_digests, v_archive_digests;
  END IF;

  INSERT INTO arena.data_contract_quarantine_batches (
    batch_id, source_slug, contract_version, reason, state,
    archive_counts, archive_digests
  ) VALUES (
    v_batch_id, v_source_slug, v_contract_version, v_reason, 'PREPARED',
    v_archive_counts, v_archive_digests
  );
END
$$;

COMMIT;
