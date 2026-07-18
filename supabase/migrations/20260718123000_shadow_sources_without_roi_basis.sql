-- gTrade and Bitfinex publish real, current leaderboard data, but neither
-- upstream exposes the capital basis needed for a real ROI:
--
--   * gTrade exposes realized PnL, win rate, and trade counts.
--   * Bitfinex exposes absolute USD PnL/volume ranking values.
--
-- Arena Score and the public ranking cohort require ROI. Keeping these rows in
-- serving_mode='serving' therefore promises a board the compute job must
-- correctly reject. Move only the ranking/read-path state back to shadow while
-- leaving status='active', so Tier A/B collection and stored PASSED snapshots
-- continue. Promotion is safe once a real upstream capital basis exists.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
DECLARE
  v_source_count integer;
  v_active_serving_count integer;
  v_sources_without_passed integer;
  v_real_roi_rows bigint;
  v_visible_rank_rows bigint;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_entries') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.trader_stats') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL THEN
    RAISE EXCEPTION 'ranking source foundations must exist before changing source visibility';
  END IF;

  SELECT
    count(*),
    count(*) FILTER (
      WHERE status = 'active' AND serving_mode = 'serving'
    )
  INTO v_source_count, v_active_serving_count
  FROM arena.sources
  WHERE slug IN ('gtrade', 'bitfinex');

  IF v_source_count <> 2 OR v_active_serving_count <> 2 THEN
    RAISE EXCEPTION
      'expected gtrade and bitfinex to be active serving sources, found % rows / % active-serving',
      v_source_count, v_active_serving_count;
  END IF;

  WITH latest_passed AS (
    SELECT DISTINCT ON (snapshot.source_id, snapshot.timeframe)
      snapshot.id,
      snapshot.source_id,
      snapshot.timeframe
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN arena.sources AS source
      ON source.id = snapshot.source_id
    WHERE source.slug IN ('gtrade', 'bitfinex')
      AND snapshot.count_check_passed
    ORDER BY
      snapshot.source_id,
      snapshot.timeframe,
      snapshot.scraped_at DESC
  )
  SELECT count(*)
  INTO v_sources_without_passed
  FROM arena.sources AS source
  WHERE source.slug IN ('gtrade', 'bitfinex')
    AND NOT EXISTS (
      SELECT 1
      FROM latest_passed
      WHERE latest_passed.source_id = source.id
    );

  IF v_sources_without_passed <> 0 THEN
    RAISE EXCEPTION
      'refusing visibility downgrade without current PASSED snapshot evidence for every target';
  END IF;

  -- Fail closed if the evidence changes before deployment. A newly available
  -- real ROI must be reviewed and ranked, not hidden by this migration.
  WITH latest_passed AS (
    SELECT DISTINCT ON (snapshot.source_id, snapshot.timeframe)
      snapshot.id,
      snapshot.source_id,
      snapshot.timeframe
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN arena.sources AS source
      ON source.id = snapshot.source_id
    WHERE source.slug IN ('gtrade', 'bitfinex')
      AND snapshot.count_check_passed
    ORDER BY
      snapshot.source_id,
      snapshot.timeframe,
      snapshot.scraped_at DESC
  )
  SELECT count(*)
  INTO v_real_roi_rows
  FROM latest_passed
  JOIN arena.leaderboard_entries AS entry
    ON entry.snapshot_id = latest_passed.id
  JOIN arena.traders AS trader
    ON trader.id = entry.trader_id
  LEFT JOIN arena.trader_stats AS stats
    ON stats.trader_id = trader.id
   AND stats.timeframe = latest_passed.timeframe
  WHERE COALESCE(entry.headline_roi, stats.roi) IS NOT NULL;

  IF v_real_roi_rows <> 0 THEN
    RAISE EXCEPTION
      'gtrade/bitfinex now have % latest PASSED rows with real ROI; review instead of shadowing',
      v_real_roi_rows;
  END IF;

  SELECT count(*)
  INTO v_visible_rank_rows
  FROM public.leaderboard_ranks AS rank_row
  WHERE rank_row.source IN ('gtrade', 'bitfinex')
    AND rank_row.season_id IN ('7D', '30D', '90D')
    AND rank_row.arena_score > 0
    AND rank_row.is_outlier IS NOT TRUE;

  IF v_visible_rank_rows <> 0 THEN
    RAISE EXCEPTION
      'gtrade/bitfinex unexpectedly have % public ranking rows; review instead of shadowing',
      v_visible_rank_rows;
  END IF;
END
$preflight$;

DO $apply$
DECLARE
  v_updated integer;
BEGIN
  UPDATE arena.sources AS source
  SET
    serving_mode = 'shadow',
    meta = COALESCE(source.meta, '{}'::jsonb) || jsonb_build_object(
      'rank_visibility', 'shadow',
      'rank_visibility_blocker', 'missing_real_roi_basis',
      'rank_visibility_reviewed_at', '2026-07-18',
      'rank_visibility_note',
        CASE source.slug
          WHEN 'gtrade' THEN
            'Upstream exposes PnL/trades but no capital basis; ROI must remain NULL.'
          WHEN 'bitfinex' THEN
            'Upstream rankings expose absolute USD PnL/volume but no ROI.'
        END
    )
  WHERE source.slug IN ('gtrade', 'bitfinex')
    AND source.status = 'active'
    AND source.serving_mode = 'serving';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 2 THEN
    RAISE EXCEPTION 'expected to shadow exactly 2 sources, updated %', v_updated;
  END IF;
END
$apply$;

DO $postflight$
DECLARE
  v_shadow_count integer;
BEGIN
  SELECT count(*)
  INTO v_shadow_count
  FROM arena.sources
  WHERE slug IN ('gtrade', 'bitfinex')
    AND status = 'active'
    AND serving_mode = 'shadow'
    AND meta->>'rank_visibility' = 'shadow'
    AND meta->>'rank_visibility_blocker' = 'missing_real_roi_basis';

  IF v_shadow_count <> 2 THEN
    RAISE EXCEPTION 'ranking visibility postflight failed: %/2 sources shadowed', v_shadow_count;
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
