-- Clean up 999 stale bitget_futures snapshots from Feb 2026
-- These records use old hex trader keys (e.g. 'bbb4487e8cb63f51a193')
-- from an earlier API format. The current VPS scraper uses numeric IDs
-- (e.g. '6796340807') and properly captures ROI/PnL.
-- All 999 records have roi_pct=NULL, pnl_usd=NULL, updated_at='2026-02-10'.

DELETE FROM trader_snapshots_v2
WHERE platform = 'bitget_futures'
  AND updated_at < '2026-03-01T00:00:00Z';

-- Also clean up corresponding stale trader_sources entries
DELETE FROM trader_sources
WHERE source = 'bitget_futures'
  AND last_seen_at < '2026-03-01T00:00:00Z';
