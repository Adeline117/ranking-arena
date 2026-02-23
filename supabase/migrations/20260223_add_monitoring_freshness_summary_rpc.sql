-- Aggregate trader snapshot freshness by source in DB (avoid API-side full table scans)

CREATE OR REPLACE FUNCTION public.get_monitoring_freshness_summary()
RETURNS TABLE (
  source text,
  last_update timestamptz,
  total bigint,
  roi_count bigint,
  win_rate_count bigint,
  max_drawdown_count bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ts.source,
    MAX(ts.captured_at) AS last_update,
    COUNT(*) AS total,
    COUNT(ts.roi) AS roi_count,
    COUNT(ts.win_rate) AS win_rate_count,
    COUNT(ts.max_drawdown) AS max_drawdown_count
  FROM public.trader_snapshots ts
  GROUP BY ts.source;
$$;

REVOKE ALL ON FUNCTION public.get_monitoring_freshness_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_monitoring_freshness_summary() TO service_role;
