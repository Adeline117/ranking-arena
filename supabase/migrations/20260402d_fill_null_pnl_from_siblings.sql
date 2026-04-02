-- Create fill_null_pnl_from_siblings function.
-- Fills NULL pnl_usd in trader_snapshots_v2 from sibling windows of the same trader.
-- Scoped to recently updated rows only to avoid full table scan timeout.

CREATE OR REPLACE FUNCTION public.fill_null_pnl_from_siblings()
RETURNS INTEGER
LANGUAGE plpgsql
SET statement_timeout = '30s'
AS $$
DECLARE
  updated_count INTEGER := 0;
BEGIN
  -- Fill NULL pnl_usd from sibling windows (same platform + trader_key, different window)
  -- Only process rows updated in the last 72 hours to avoid full table scan
  WITH needs_fill AS (
    SELECT id, platform, trader_key, window
    FROM trader_snapshots_v2
    WHERE pnl_usd IS NULL
      AND updated_at > NOW() - INTERVAL '72 hours'
      AND roi_pct IS NOT NULL  -- Only fill for traders that have ROI (active traders)
    LIMIT 5000
  ),
  sibling_pnl AS (
    SELECT DISTINCT ON (nf.id)
      nf.id,
      sv2.pnl_usd
    FROM needs_fill nf
    JOIN trader_snapshots_v2 sv2
      ON sv2.platform = nf.platform
      AND sv2.trader_key = nf.trader_key
      AND sv2.window != nf.window
      AND sv2.pnl_usd IS NOT NULL
      AND sv2.updated_at > NOW() - INTERVAL '7 days'
    ORDER BY nf.id, sv2.updated_at DESC
  )
  UPDATE trader_snapshots_v2 t
  SET pnl_usd = sp.pnl_usd
  FROM sibling_pnl sp
  WHERE t.id = sp.id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

COMMENT ON FUNCTION public.fill_null_pnl_from_siblings IS 'Fill NULL pnl_usd from sibling windows for same trader. Used by compute-leaderboard cron.';
