-- Atomic CUTOVER for the GMX PnL-contract-v2 batch prepared by 231500.
-- Mutations use archived stable keys only. GMX ingest and compute-leaderboard
-- must remain stopped until this transaction records COMPLETE.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '240s';
SET LOCAL TIME ZONE 'UTC';

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
  v_batch arena.data_contract_quarantine_batches%ROWTYPE;
  v_source_id smallint;
  v_archive_counts jsonb;
  v_archive_digests jsonb;
  v_live_counts jsonb;
  v_live_digests jsonb;
  v_cutover_counts jsonb;
  v_was_prepared boolean := false;
  v_snapshots_disabled bigint := 0;
  v_stats_sanitized bigint := 0;
  v_daily_deleted bigint := 0;
  v_weekly_deleted bigint := 0;
  v_ranks_deleted bigint := 0;
  v_cache_deleted bigint := 0;
  v_source_updated bigint := 0;
  v_final_count bigint;
BEGIN
  SELECT *
  INTO v_batch
  FROM arena.data_contract_quarantine_batches
  WHERE batch_id = v_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GMX CUTOVER requires PREPARE batch %', v_batch_id;
  END IF;
  IF v_batch.source_slug <> v_source_slug
     OR v_batch.contract_version <> v_contract_version
     OR v_batch.reason <> v_reason THEN
    RAISE EXCEPTION 'GMX CUTOVER batch identity mismatch for %', v_batch_id;
  END IF;
  IF v_batch.state NOT IN ('PREPARED', 'COMPLETE') THEN
    RAISE EXCEPTION 'unknown GMX CUTOVER batch state %', v_batch.state;
  END IF;

  SELECT source_id
  INTO v_source_id
  FROM arena.source_registry_quarantine
  WHERE batch_id = v_batch_id AND source_slug = v_source_slug;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GMX CUTOVER source archive is missing for %', v_batch_id;
  END IF;

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

  IF v_batch.archive_counts <> v_archive_counts
     OR v_batch.archive_digests <> v_archive_digests THEN
    RAISE EXCEPTION 'GMX CUTOVER archive count/digest mismatch for %', v_batch_id;
  END IF;

  IF (v_archive_counts->>'source_registry')::bigint <> 1 THEN
    RAISE EXCEPTION 'GMX CUTOVER expected one archived source, got %', v_archive_counts;
  END IF;

  IF v_batch.state = 'COMPLETE' THEN
    IF (v_batch.cutover_counts->>'source_updated') IS DISTINCT FROM '1'
       OR (v_batch.cutover_counts->>'snapshots_disabled')
          IS DISTINCT FROM (v_archive_counts->>'leaderboard_snapshots')
       OR (v_batch.cutover_counts->>'stats_sanitized')
          IS DISTINCT FROM (v_archive_counts->>'trader_stats')
       OR (v_batch.cutover_counts->>'trader_series_deleted')
          IS DISTINCT FROM (v_archive_counts->>'trader_series')
       OR (v_batch.cutover_counts->>'trader_series_weekly_deleted')
          IS DISTINCT FROM (v_archive_counts->>'trader_series_weekly')
       OR (v_batch.cutover_counts->>'leaderboard_ranks_deleted')
          IS DISTINCT FROM (v_archive_counts->>'leaderboard_ranks')
       OR (v_batch.cutover_counts->>'leaderboard_count_cache_deleted')
          IS DISTINCT FROM (v_archive_counts->>'leaderboard_count_cache') THEN
      RAISE EXCEPTION 'GMX COMPLETE cutover-count ledger mismatch for %', v_batch_id;
    END IF;
  ELSE
    v_was_prepared := true;

    -- PREPARE and CUTOVER are one operational maintenance window. These exact
    -- live digests prove no unversioned snapshot/rank writer ran in between.
    SELECT jsonb_build_object(
      'source_registry', (SELECT count(*) FROM arena.sources WHERE id = v_source_id),
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
        SELECT md5(COALESCE(string_agg(to_jsonb(source_row)::text, E'\n'
          ORDER BY source_row.id), ''))
        FROM arena.sources AS source_row WHERE source_row.id = v_source_id
      ),
      'leaderboard_snapshots', (
        SELECT md5(COALESCE(string_agg(to_jsonb(snapshot)::text, E'\n'
          ORDER BY snapshot.id), ''))
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

    IF v_live_counts <> v_archive_counts OR v_live_digests <> v_archive_digests THEN
      RAISE EXCEPTION
        'GMX live rows changed after PREPARE; refusing CUTOVER: live %, archive %',
        v_live_counts, v_archive_counts;
    END IF;

    UPDATE arena.leaderboard_snapshots AS snapshot
    SET count_check_passed = false,
        meta = COALESCE(snapshot.meta, '{}'::jsonb) || jsonb_build_object(
          'quarantine_batch_id', v_batch_id,
          'quarantine_reason', v_reason
        )
    FROM arena.leaderboard_snapshots_quarantine AS archive
    WHERE archive.batch_id = v_batch_id
      AND snapshot.id = archive.snapshot_id;
    GET DIAGNOSTICS v_snapshots_disabled = ROW_COUNT;

    UPDATE arena.trader_stats AS stats
    SET roi = NULL,
        pnl = NULL,
        sharpe = NULL,
        mdd = NULL,
        win_rate = NULL,
        win_positions = NULL,
        total_positions = NULL,
        aum = NULL,
        volume = NULL,
        holding_duration_avg = NULL,
        extras = (
          COALESCE(stats.extras, '{}'::jsonb) - ARRAY[
            'pnl_basis', 'roi_basis', 'pnl_includes_unrealized',
            'realized_pnl_usd', 'pnl_components_complete',
            'total_pnl_incl_unrealized_usd', 'total_pnl_source',
            'gmx_total_mark_to_market_pnl_usd', 'gmx_total_mark_to_market_source',
            'gmx_history_client_window_cutoff', 'gmx_history_rows_raw',
            'gmx_history_rows_in_window', 'profile_series_contract',
            'profile_window_metrics_complete', 'profile_window_empty',
            'empty_window_evidence', 'profile_window_metrics_incomplete_reason',
            'window_from', 'window_to', 'window_duration_days', 'window_semantics',
            'aum_basis', 'closed_count', 'risk_derivation', 'risk_samples',
            'risk_self_derived', 'risk_derived_samples', 'sortino',
            'volatility', 'roe_volatility'
          ]::text[]
        ) || jsonb_build_object(
          'gmx_pnl_contract_quarantined', true,
          'quarantine_batch_id', v_batch_id,
          'quarantine_reason', v_reason
        )
    FROM arena.trader_stats_quarantine AS archive
    WHERE archive.batch_id = v_batch_id
      AND stats.trader_id = archive.trader_id
      AND stats.timeframe = archive.timeframe;
    GET DIAGNOSTICS v_stats_sanitized = ROW_COUNT;

    DELETE FROM arena.trader_series AS series
    USING arena.trader_series_quarantine AS archive
    WHERE archive.batch_id = v_batch_id
      AND archive.original_table = 'trader_series'
      AND series.trader_id = archive.trader_id
      AND series.timeframe = archive.timeframe
      AND series.metric = archive.metric
      AND series.ts = archive.point_at;
    GET DIAGNOSTICS v_daily_deleted = ROW_COUNT;

    DELETE FROM arena.trader_series_weekly AS series
    USING arena.trader_series_quarantine AS archive
    WHERE archive.batch_id = v_batch_id
      AND archive.original_table = 'trader_series_weekly'
      AND series.trader_id = archive.trader_id
      AND series.timeframe = archive.timeframe
      AND series.metric = archive.metric
      AND series.week_start = (archive.point_at AT TIME ZONE 'UTC')::date;
    GET DIAGNOSTICS v_weekly_deleted = ROW_COUNT;

    DELETE FROM public.leaderboard_ranks AS rank_row
    USING arena.leaderboard_ranks_quarantine AS archive
    WHERE archive.batch_id = v_batch_id
      AND rank_row.id = archive.rank_id
      AND rank_row.season_id = archive.season_id
      AND rank_row.source = archive.source_slug
      AND rank_row.source_trader_id = archive.source_trader_id;
    GET DIAGNOSTICS v_ranks_deleted = ROW_COUNT;

    DELETE FROM public.leaderboard_count_cache AS cache_row
    USING arena.leaderboard_count_cache_quarantine AS archive
    WHERE archive.batch_id = v_batch_id
      AND cache_row.season_id = archive.season_id
      AND cache_row.source = archive.cache_source;
    GET DIAGNOSTICS v_cache_deleted = ROW_COUNT;

    IF to_regprocedure('public.refresh_leaderboard_count_cache()') IS NULL THEN
      RAISE EXCEPTION 'GMX CUTOVER requires public.refresh_leaderboard_count_cache()';
    END IF;
    PERFORM public.refresh_leaderboard_count_cache();

    -- Source v2 becomes visible only after every old serving/materialized
    -- surface has been fenced or removed.
    UPDATE arena.sources AS source_row
    SET timeframes_native = ARRAY[7, 30, 90]::integer[],
        timeframes_derived = ARRAY[]::integer[],
        meta = ((COALESCE(source_row.meta, '{}'::jsonb) - 'compute_90d')
          - 'unavailable_timeframes') || jsonb_build_object(
          'endpoints',
          CASE
            WHEN jsonb_typeof(source_row.meta->'endpoints') = 'object'
              THEN source_row.meta->'endpoints'
            ELSE '{}'::jsonb
          END || jsonb_build_object(
            'subgraph', 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
          ),
          'pnl_basis_board', 'gmx_period_realized_net',
          'roi_basis_board', 'max_capital_usd',
          'pnl_includes_unrealized', false,
          'pnl_provenance', 'arena_normalized_from_gmx_period_components',
          'pnl_contract_version', 2,
          'window_semantics', 'completed_utc_days',
          'window_timezone', 'UTC',
          'window_max_lag_hours', 24
        )
    FROM arena.source_registry_quarantine AS archive
    WHERE archive.batch_id = v_batch_id
      AND source_row.id = archive.source_id
      AND source_row.slug = archive.source_slug;
    GET DIAGNOSTICS v_source_updated = ROW_COUNT;

    IF v_source_updated <> 1
       OR v_snapshots_disabled <> (v_archive_counts->>'leaderboard_snapshots')::bigint
       OR v_stats_sanitized <> (v_archive_counts->>'trader_stats')::bigint
       OR v_daily_deleted <> (v_archive_counts->>'trader_series')::bigint
       OR v_weekly_deleted <> (v_archive_counts->>'trader_series_weekly')::bigint
       OR v_ranks_deleted <> (v_archive_counts->>'leaderboard_ranks')::bigint
       OR v_cache_deleted <> (v_archive_counts->>'leaderboard_count_cache')::bigint THEN
      RAISE EXCEPTION
        'GMX CUTOVER mutation mismatch source %, snapshots %, stats %, daily %, weekly %, ranks %, cache %, expected %',
        v_source_updated, v_snapshots_disabled, v_stats_sanitized,
        v_daily_deleted, v_weekly_deleted, v_ranks_deleted, v_cache_deleted,
        v_archive_counts;
    END IF;
  END IF;

  -- Common final invariants also make COMPLETE replays verification-only.
  SELECT count(*)
  INTO v_final_count
  FROM arena.sources AS source_row
  JOIN arena.source_registry_quarantine AS archive
    ON archive.batch_id = v_batch_id AND archive.source_id = source_row.id
  WHERE source_row.slug = v_source_slug
    AND source_row.timeframes_native IS NOT DISTINCT FROM ARRAY[7, 30, 90]::integer[]
    AND source_row.timeframes_derived IS NOT DISTINCT FROM ARRAY[]::integer[]
    AND source_row.meta->'endpoints'->>'subgraph'
      IS NOT DISTINCT FROM 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
    AND source_row.meta->>'pnl_basis_board' IS NOT DISTINCT FROM 'gmx_period_realized_net'
    AND source_row.meta->>'roi_basis_board' IS NOT DISTINCT FROM 'max_capital_usd'
    AND source_row.meta->>'pnl_includes_unrealized' IS NOT DISTINCT FROM 'false'
    AND source_row.meta->>'pnl_contract_version' IS NOT DISTINCT FROM '2'
    AND source_row.meta->>'window_semantics' IS NOT DISTINCT FROM 'completed_utc_days'
    AND source_row.meta->>'window_timezone' IS NOT DISTINCT FROM 'UTC'
    AND source_row.meta->>'window_max_lag_hours' IS NOT DISTINCT FROM '24'
    AND NOT (source_row.meta ? 'compute_90d')
    AND NOT (source_row.meta ? 'unavailable_timeframes');
  IF v_final_count <> 1 THEN
    RAISE EXCEPTION 'GMX source v2 final contract verification failed';
  END IF;

  SELECT count(*)
  INTO v_final_count
  FROM arena.leaderboard_snapshots_quarantine AS archive
  JOIN arena.leaderboard_snapshots AS snapshot ON snapshot.id = archive.snapshot_id
  WHERE archive.batch_id = v_batch_id AND snapshot.count_check_passed = false;
  IF v_final_count <> (v_archive_counts->>'leaderboard_snapshots')::bigint
     OR EXISTS (
       SELECT 1
       FROM arena.leaderboard_snapshots AS snapshot
       WHERE snapshot.source_id = v_source_id AND snapshot.count_check_passed
     ) THEN
    RAISE EXCEPTION 'GMX passed snapshots remain after CUTOVER';
  END IF;

  SELECT count(*)
  INTO v_final_count
  FROM arena.trader_stats_quarantine AS archive
  JOIN arena.trader_stats AS stats
    ON stats.trader_id = archive.trader_id AND stats.timeframe = archive.timeframe
  WHERE archive.batch_id = v_batch_id
    AND stats.roi IS NULL
    AND stats.pnl IS NULL
    AND stats.sharpe IS NULL
    AND stats.mdd IS NULL
    AND stats.win_rate IS NULL
    AND stats.win_positions IS NULL
    AND stats.total_positions IS NULL
    AND stats.aum IS NULL
    AND stats.volume IS NULL
    AND stats.holding_duration_avg IS NULL
    AND stats.extras->>'gmx_pnl_contract_quarantined' = 'true'
    AND stats.extras->>'quarantine_batch_id' = v_batch_id
    AND NOT (stats.extras ?| ARRAY[
      'pnl_basis', 'roi_basis', 'pnl_includes_unrealized', 'realized_pnl_usd',
      'pnl_components_complete', 'total_pnl_incl_unrealized_usd',
      'total_pnl_source', 'gmx_total_mark_to_market_pnl_usd',
      'gmx_total_mark_to_market_source', 'gmx_history_client_window_cutoff',
      'gmx_history_rows_raw', 'gmx_history_rows_in_window',
      'profile_series_contract', 'profile_window_metrics_complete',
      'profile_window_empty', 'empty_window_evidence',
      'profile_window_metrics_incomplete_reason', 'window_from', 'window_to',
      'window_duration_days', 'window_semantics', 'aum_basis', 'closed_count',
      'risk_derivation', 'risk_samples', 'risk_self_derived',
      'risk_derived_samples', 'sortino', 'volatility', 'roe_volatility'
    ]);
  IF v_final_count <> (v_archive_counts->>'trader_stats')::bigint THEN
    RAISE EXCEPTION 'GMX mixed-window stats remain after CUTOVER';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.trader_series AS series
    JOIN arena.traders AS trader ON trader.id = series.trader_id
    WHERE trader.source_id = v_source_id AND series.metric = 'pnl'
  ) OR EXISTS (
    SELECT 1
    FROM arena.trader_series_weekly AS series
    JOIN arena.traders AS trader ON trader.id = series.trader_id
    WHERE trader.source_id = v_source_id AND series.metric = 'pnl'
  ) THEN
    RAISE EXCEPTION 'GMX generic PnL series remain after CUTOVER';
  END IF;

  IF EXISTS (SELECT 1 FROM public.leaderboard_ranks WHERE source = v_source_slug) THEN
    RAISE EXCEPTION 'GMX public ranks remain after CUTOVER';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leaderboard_count_cache
    WHERE source IN ('gmx', 'gmx_gt0')
  ) THEN
    RAISE EXCEPTION 'GMX direct count-cache rows remain after CUTOVER';
  END IF;

  IF EXISTS (
    WITH seasons(season_id) AS (
      VALUES ('7D'::text), ('30D'::text), ('90D'::text)
    ), expected AS (
      SELECT season.season_id,
             count(rank_row.*) FILTER (
               WHERE rank_row.arena_score > 10
                 AND (rank_row.is_outlier IS NULL OR rank_row.is_outlier = false)
             )::bigint AS quality_count,
             count(rank_row.*) FILTER (
               WHERE rank_row.arena_score > 0
                 AND (rank_row.is_outlier IS NULL OR rank_row.is_outlier = false)
             )::bigint AS active_count
      FROM seasons AS season
      LEFT JOIN public.leaderboard_ranks AS rank_row
        ON rank_row.season_id = season.season_id
      GROUP BY season.season_id
    )
    SELECT 1
    FROM expected
    LEFT JOIN public.leaderboard_count_cache AS quality_cache
      ON quality_cache.season_id = expected.season_id AND quality_cache.source = '_all'
    LEFT JOIN public.leaderboard_count_cache AS active_cache
      ON active_cache.season_id = expected.season_id AND active_cache.source = '_all_gt0'
    WHERE COALESCE(quality_cache.total_count, 0) <> expected.quality_count
       OR COALESCE(active_cache.total_count, 0) <> expected.active_count
  ) THEN
    RAISE EXCEPTION 'global leaderboard count cache does not match live ranks';
  END IF;

  IF v_was_prepared THEN
    v_cutover_counts := jsonb_build_object(
      'source_updated', v_source_updated,
      'snapshots_disabled', v_snapshots_disabled,
      'stats_sanitized', v_stats_sanitized,
      'trader_series_deleted', v_daily_deleted,
      'trader_series_weekly_deleted', v_weekly_deleted,
      'leaderboard_ranks_deleted', v_ranks_deleted,
      'leaderboard_count_cache_deleted', v_cache_deleted
    );

    UPDATE arena.data_contract_quarantine_batches
    SET state = 'COMPLETE',
        cutover_at = statement_timestamp(),
        cutover_counts = v_cutover_counts
    WHERE batch_id = v_batch_id AND state = 'PREPARED';
    GET DIAGNOSTICS v_final_count = ROW_COUNT;
    IF v_final_count <> 1 THEN
      RAISE EXCEPTION 'GMX CUTOVER failed to mark COMPLETE';
    END IF;
  ELSE
    RAISE NOTICE 'GMX batch % already COMPLETE; final invariants verified', v_batch_id;
  END IF;
END
$$;

COMMIT;
