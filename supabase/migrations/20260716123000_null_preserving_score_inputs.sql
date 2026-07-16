-- Migration: preserve unknown score inputs as NULL
--
-- PostgreSQL GREATEST/LEAST ignore NULL arguments. The previous clamps therefore
-- converted an unknown ROI, win rate, or drawdown into -10000, 0, or 100. Those
-- are real metric values and must never stand in for missing upstream evidence.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.score_inputs') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_entries') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.trader_stats') IS NULL THEN
    RAISE EXCEPTION 'score-input foundations must exist before preserving NULL metrics';
  END IF;

  IF pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'service_role must exist before preserving NULL metrics';
  END IF;
END
$preflight$;

CREATE TEMP TABLE score_input_counts_before
ON COMMIT DROP
AS
SELECT platform, "window", count(*)::bigint AS row_count
FROM arena.score_inputs
GROUP BY platform, "window";

CREATE OR REPLACE VIEW arena.score_inputs AS
WITH latest_passed AS (
  SELECT DISTINCT ON (ls.source_id, ls.timeframe)
         ls.id AS snapshot_id, ls.source_id, ls.timeframe, ls.scraped_at
    FROM arena.leaderboard_snapshots ls
   WHERE ls.count_check_passed
   ORDER BY ls.source_id, ls.timeframe, ls.scraped_at DESC
),
fp_fresh AS (
  SELECT st.trader_id, st.timeframe
    FROM arena.trader_stats st
    JOIN arena.traders t ON t.id = st.trader_id
   WHERE t.meta->>'claimed' = 'true'
     AND st.extras->>'provenance' = 'first_party'
     AND st.as_of > now() - interval '48 hours'
)
-- Board rows remain present, but fresh claimed first-party rows take precedence.
SELECT
  COALESCE(s.meta->>'legacy_platform', s.slug)             AS platform,
  CASE WHEN s.product_type = 'spot' THEN 'spot' ELSE 'futures' END AS market_type,
  t.exchange_trader_id                                     AS trader_key,
  (lp.timeframe::text || 'D')                              AS "window",
  e.rank                                                   AS board_rank,
  CASE
    WHEN COALESCE(e.headline_roi, st.roi) IS NULL THEN NULL::numeric
    ELSE LEAST(GREATEST(COALESCE(e.headline_roi, st.roi), -10000), 10000)
  END                                                      AS roi_pct,
  COALESCE(e.headline_pnl, st.pnl)                         AS pnl_usd,
  CASE
    WHEN COALESCE(e.headline_win_rate, st.win_rate) IS NULL THEN NULL::numeric
    ELSE LEAST(GREATEST(COALESCE(e.headline_win_rate, st.win_rate), 0), 100)
  END                                                      AS win_rate,
  CASE
    WHEN st.mdd IS NULL THEN NULL::numeric
    ELSE LEAST(abs(st.mdd), 100)
  END                                                      AS max_drawdown,
  st.copier_count                                          AS copiers,
  st.total_positions                                       AS trades_count,
  st.sharpe                                                AS sharpe_ratio,
  (st.extras->>'sortino')::numeric                         AS sortino_ratio,
  (st.extras->>'calmar')::numeric                          AS calmar_ratio,
  (st.extras->>'volatility')::numeric                      AS volatility_pct,
  t.trader_kind,
  t.nickname                                               AS handle,
  COALESCE(t.avatar_url_mirror, t.avatar_url_origin)       AS avatar_url,
  s.currency,
  lp.scraped_at                                            AS as_of
FROM latest_passed lp
JOIN arena.sources s             ON s.id = lp.source_id
JOIN arena.leaderboard_entries e ON e.snapshot_id = lp.snapshot_id
JOIN arena.traders t             ON t.id = e.trader_id
LEFT JOIN arena.trader_stats st  ON st.trader_id = t.id AND st.timeframe = lp.timeframe
WHERE s.serving_mode <> 'legacy'
  AND s.currency = ANY (ARRAY['USDT','USDx','USDC','USD'])
  AND (s.meta->>'legacy_platform') IS DISTINCT FROM 'null'
  AND NOT EXISTS (
    SELECT 1
      FROM fp_fresh f
     WHERE f.trader_id = t.id
       AND f.timeframe = lp.timeframe
  )

UNION ALL

-- A claimed trader uses fresh first-party metrics, with the same NULL contract.
SELECT
  COALESCE(s.meta->>'legacy_platform', s.slug)             AS platform,
  CASE WHEN s.product_type = 'spot' THEN 'spot' ELSE 'futures' END AS market_type,
  t.exchange_trader_id                                     AS trader_key,
  (st.timeframe::text || 'D')                              AS "window",
  br.rank                                                  AS board_rank,
  CASE
    WHEN st.roi IS NULL THEN NULL::numeric
    ELSE LEAST(GREATEST(st.roi, -10000), 10000)
  END                                                      AS roi_pct,
  st.pnl                                                   AS pnl_usd,
  CASE
    WHEN st.win_rate IS NULL THEN NULL::numeric
    ELSE LEAST(GREATEST(st.win_rate, 0), 100)
  END                                                      AS win_rate,
  CASE
    WHEN st.mdd IS NULL THEN NULL::numeric
    ELSE LEAST(abs(st.mdd), 100)
  END                                                      AS max_drawdown,
  st.copier_count                                          AS copiers,
  st.total_positions                                       AS trades_count,
  st.sharpe                                                AS sharpe_ratio,
  (st.extras->>'sortino')::numeric                         AS sortino_ratio,
  (st.extras->>'calmar')::numeric                          AS calmar_ratio,
  (st.extras->>'volatility')::numeric                      AS volatility_pct,
  t.trader_kind,
  t.nickname                                               AS handle,
  COALESCE(t.avatar_url_mirror, t.avatar_url_origin)       AS avatar_url,
  s.currency,
  st.as_of                                                 AS as_of
FROM arena.traders t
JOIN arena.sources s       ON s.id = t.source_id
JOIN arena.trader_stats st ON st.trader_id = t.id AND st.timeframe IN (7, 30, 90)
LEFT JOIN LATERAL (
  SELECT e2.rank
    FROM latest_passed lp2
    JOIN arena.leaderboard_entries e2
      ON e2.snapshot_id = lp2.snapshot_id
     AND e2.trader_id = t.id
   WHERE lp2.source_id = s.id
     AND lp2.timeframe = st.timeframe
   LIMIT 1
) br ON true
WHERE t.meta->>'claimed' = 'true'
  AND st.extras->>'provenance' = 'first_party'
  AND st.as_of > now() - interval '48 hours'
  AND s.currency = ANY (ARRAY['USDT','USDx','USDC','USD']);

GRANT SELECT ON arena.score_inputs TO service_role;

DO $postflight$
DECLARE
  v_view_owner name;
BEGIN
  IF EXISTS (
    WITH counts_after AS (
      SELECT platform, "window", count(*)::bigint AS row_count
      FROM arena.score_inputs
      GROUP BY platform, "window"
    )
    SELECT 1
    FROM score_input_counts_before before_count
    FULL JOIN counts_after after_count
      USING (platform, "window")
    WHERE before_count.row_count IS DISTINCT FROM after_count.row_count
       OR before_count.platform IS NULL
       OR after_count.platform IS NULL
  ) THEN
    RAISE EXCEPTION 'NULL-preserving score-input migration changed source/window row counts';
  END IF;

  IF NOT pg_catalog.has_table_privilege('service_role', 'arena.score_inputs', 'SELECT') THEN
    RAISE EXCEPTION 'service_role lost score_inputs SELECT access';
  END IF;

  SELECT owner.rolname
    INTO v_view_owner
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_roles owner ON owner.oid = relation.relowner
   WHERE relation.oid = 'arena.score_inputs'::regclass;

  IF v_view_owner IS NULL THEN
    RAISE EXCEPTION 'score_inputs view owner could not be resolved';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
