-- Enrich trades_count using COALESCE(open_time, close_time) as position timestamp

-- 7D
UPDATE trader_snapshots ts
SET trades_count = sub.cnt
FROM (
  SELECT source, source_trader_id, COUNT(*) as cnt
  FROM trader_position_history
  WHERE COALESCE(open_time, close_time) >= NOW() - INTERVAL '7 days'
  GROUP BY source, source_trader_id
) sub
WHERE ts.source = sub.source
  AND ts.source_trader_id = sub.source_trader_id
  AND ts.season_id = '7D'
  AND ts.trades_count IS NULL;

-- 30D
UPDATE trader_snapshots ts
SET trades_count = sub.cnt
FROM (
  SELECT source, source_trader_id, COUNT(*) as cnt
  FROM trader_position_history
  WHERE COALESCE(open_time, close_time) >= NOW() - INTERVAL '30 days'
  GROUP BY source, source_trader_id
) sub
WHERE ts.source = sub.source
  AND ts.source_trader_id = sub.source_trader_id
  AND ts.season_id = '30D'
  AND ts.trades_count IS NULL;

-- 90D
UPDATE trader_snapshots ts
SET trades_count = sub.cnt
FROM (
  SELECT source, source_trader_id, COUNT(*) as cnt
  FROM trader_position_history
  WHERE COALESCE(open_time, close_time) >= NOW() - INTERVAL '90 days'
  GROUP BY source, source_trader_id
) sub
WHERE ts.source = sub.source
  AND ts.source_trader_id = sub.source_trader_id
  AND ts.season_id = '90D'
  AND ts.trades_count IS NULL;
