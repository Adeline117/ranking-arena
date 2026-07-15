-- Keep approximate wallet reconstruction out of typed Arena Score inputs.
--
-- The original enrichment RPC copied an estimated on-chain win rate into
-- arena.trader_stats.win_rate whenever the exchange-owned value was NULL.
-- Keep the public signature for deployed callers, but make persistence
-- extras-only. Quarantine only values with no native leaderboard history;
-- values that ever appeared as an exchange headline are deliberately kept.

BEGIN;

CREATE OR REPLACE FUNCTION public.arena_apply_onchain_enrichment(
  p_source text,
  p_exchange_trader_id text,
  p_extras jsonb,
  p_win_rate numeric DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, arena
AS $$
DECLARE
  v_updated integer;
BEGIN
  -- p_win_rate is retained for wire compatibility and intentionally ignored.
  UPDATE arena.trader_stats AS ts
  SET extras = COALESCE(ts.extras, '{}'::jsonb) || COALESCE(p_extras, '{}'::jsonb)
  FROM arena.traders AS t
  JOIN arena.sources AS s ON s.id = t.source_id
  WHERE ts.trader_id = t.id
    AND s.slug = p_source
    AND t.exchange_trader_id = p_exchange_trader_id
    AND ts.timeframe = 90;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.arena_apply_onchain_enrichment(text, text, jsonb, numeric)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_apply_onchain_enrichment(text, text, jsonb, numeric)
TO service_role;

COMMENT ON FUNCTION public.arena_apply_onchain_enrichment(text, text, jsonb, numeric) IS
  'Persists on-chain enrichment in extras only; p_win_rate is compatibility-only and ignored.';

-- Production preflight found two high-confidence rows. Stop instead of making
-- a broad cleanup if another environment has materially drifted.
DO $$
DECLARE
  v_candidate_count integer;
BEGIN
  WITH suspected AS MATERIALIZED (
    SELECT ts.trader_id, ts.timeframe
    FROM arena.trader_stats AS ts
    JOIN arena.traders AS t ON t.id = ts.trader_id
    JOIN arena.sources AS s ON s.id = t.source_id
    WHERE s.slug = 'binance_web3_bsc'
      AND ts.timeframe = 90
      AND ts.extras->>'onchain_derivation' = 'onchain-computed'
      AND (ts.extras->>'onchain_score_eligible') IS DISTINCT FROM 'true'
      AND (ts.extras->>'provenance') IS DISTINCT FROM 'first_party'
      AND jsonb_typeof(ts.extras->'onchain_win_rate') = 'number'
      AND ts.win_rate IS NOT NULL
      AND ts.win_rate = (ts.extras->>'onchain_win_rate')::numeric
  )
  SELECT count(*)
  INTO v_candidate_count
  FROM suspected AS x
  WHERE NOT EXISTS (
    SELECT 1
    FROM arena.leaderboard_entries AS e
    WHERE e.trader_id = x.trader_id
      AND e.timeframe = x.timeframe
      AND e.headline_win_rate IS NOT NULL
  );

  IF v_candidate_count > 10 THEN
    RAISE EXCEPTION
      'refusing approximate on-chain win-rate quarantine: % candidates exceeds safety cap 10',
      v_candidate_count;
  END IF;
END
$$;

WITH suspected AS MATERIALIZED (
  SELECT ts.trader_id, ts.timeframe, ts.win_rate
  FROM arena.trader_stats AS ts
  JOIN arena.traders AS t ON t.id = ts.trader_id
  JOIN arena.sources AS s ON s.id = t.source_id
  WHERE s.slug = 'binance_web3_bsc'
    AND ts.timeframe = 90
    AND ts.extras->>'onchain_derivation' = 'onchain-computed'
    AND (ts.extras->>'onchain_score_eligible') IS DISTINCT FROM 'true'
    AND (ts.extras->>'provenance') IS DISTINCT FROM 'first_party'
    AND jsonb_typeof(ts.extras->'onchain_win_rate') = 'number'
    AND ts.win_rate IS NOT NULL
    AND ts.win_rate = (ts.extras->>'onchain_win_rate')::numeric
), derived_only AS MATERIALIZED (
  SELECT x.*
  FROM suspected AS x
  WHERE NOT EXISTS (
    SELECT 1
    FROM arena.leaderboard_entries AS e
    WHERE e.trader_id = x.trader_id
      AND e.timeframe = x.timeframe
      AND e.headline_win_rate IS NOT NULL
  )
)
UPDATE arena.trader_stats AS ts
SET
  win_rate = NULL,
  extras = COALESCE(ts.extras, '{}'::jsonb) || jsonb_build_object(
    'onchain_typed_win_rate_quarantine',
    jsonb_build_object(
      'value', d.win_rate,
      'at', statement_timestamp(),
      'reason', 'approximate_onchain_value_without_native_history',
      'migration', '20260715212448'
    )
  )
FROM derived_only AS d
WHERE ts.trader_id = d.trader_id
  AND ts.timeframe = d.timeframe;

COMMIT;
