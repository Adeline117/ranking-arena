-- Enrich trades_count from trader_position_history
-- For each (source, source_trader_id, season_id), count positions opened within the time window

-- 7D: positions opened in last 7 days
UPDATE trader_snapshots ts
SET trades_count = sub.cnt
FROM (
  SELECT source, source_trader_id, COUNT(*) as cnt
  FROM trader_position_history
  WHERE open_time >= NOW() - INTERVAL '7 days'
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
  WHERE open_time >= NOW() - INTERVAL '30 days'
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
  WHERE open_time >= NOW() - INTERVAL '90 days'
  GROUP BY source, source_trader_id
) sub
WHERE ts.source = sub.source
  AND ts.source_trader_id = sub.source_trader_id
  AND ts.season_id = '90D'
  AND ts.trades_count IS NULL;
