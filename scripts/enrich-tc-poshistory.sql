-- Enrich trades_count from trader_position_history
-- Uses COALESCE(open_time, close_time) as the position timestamp
-- Also handles okx_web3 -> okx_futures mapping

-- 7D: binance_futures, hyperliquid, jupiter_perps, binance (direct match)
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

-- 7D: okx_web3 snapshots -> okx_futures position history
UPDATE trader_snapshots ts
SET trades_count = sub.cnt
FROM (
  SELECT source_trader_id, COUNT(*) as cnt
  FROM trader_position_history
  WHERE source = 'okx_futures'
    AND COALESCE(open_time, close_time) >= NOW() - INTERVAL '7 days'
  GROUP BY source_trader_id
) sub
WHERE ts.source = 'okx_web3'
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

-- 30D: okx_web3
UPDATE trader_snapshots ts
SET trades_count = sub.cnt
FROM (
  SELECT source_trader_id, COUNT(*) as cnt
  FROM trader_position_history
  WHERE source = 'okx_futures'
    AND COALESCE(open_time, close_time) >= NOW() - INTERVAL '30 days'
  GROUP BY source_trader_id
) sub
WHERE ts.source = 'okx_web3'
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

-- 90D: okx_web3
UPDATE trader_snapshots ts
SET trades_count = sub.cnt
FROM (
  SELECT source_trader_id, COUNT(*) as cnt
  FROM trader_position_history
  WHERE source = 'okx_futures'
    AND COALESCE(open_time, close_time) >= NOW() - INTERVAL '90 days'
  GROUP BY source_trader_id
) sub
WHERE ts.source = 'okx_web3'
  AND ts.source_trader_id = sub.source_trader_id
  AND ts.season_id = '90D'
  AND ts.trades_count IS NULL;

-- Also use total position count for traders where ALL their positions are in range
-- For hyperliquid with NULL open_time, count all closed positions as the total
UPDATE trader_snapshots ts
SET trades_count = sub.cnt
FROM (
  SELECT source, source_trader_id, COUNT(*) as cnt
  FROM trader_position_history
  WHERE source = 'hyperliquid'
  GROUP BY source, source_trader_id
) sub
WHERE ts.source = 'hyperliquid'
  AND ts.source_trader_id = sub.source_trader_id
  AND ts.season_id = '90D'
  AND ts.trades_count IS NULL;

-- For hyperliquid 30D: scale 90D count by 30/90
UPDATE trader_snapshots ts
SET trades_count = GREATEST(1, ROUND(sub.cnt * 30.0 / 90))
FROM (
  SELECT source, source_trader_id, COUNT(*) as cnt
  FROM trader_position_history
  WHERE source = 'hyperliquid'
    AND COALESCE(close_time, captured_at) >= NOW() - INTERVAL '30 days'
  GROUP BY source, source_trader_id
) sub
WHERE ts.source = 'hyperliquid'
  AND ts.source_trader_id = sub.source_trader_id
  AND ts.season_id = '30D'
  AND ts.trades_count IS NULL;

-- For hyperliquid 7D
UPDATE trader_snapshots ts
SET trades_count = GREATEST(1, sub.cnt)
FROM (
  SELECT source, source_trader_id, COUNT(*) as cnt
  FROM trader_position_history
  WHERE source = 'hyperliquid'
    AND COALESCE(close_time, captured_at) >= NOW() - INTERVAL '7 days'
  GROUP BY source, source_trader_id
) sub
WHERE ts.source = 'hyperliquid'
  AND ts.source_trader_id = sub.source_trader_id
  AND ts.season_id = '7D'
  AND ts.trades_count IS NULL;

-- Cross-season inference: if one season has tc, estimate others
-- 90D -> 30D (scale by 30/90)
UPDATE trader_snapshots ts
SET trades_count = GREATEST(1, ROUND(ref.trades_count * 30.0 / 90))
FROM trader_snapshots ref
WHERE ts.source = ref.source
  AND ts.source_trader_id = ref.source_trader_id
  AND ref.season_id = '90D'
  AND ref.trades_count IS NOT NULL
  AND ts.season_id = '30D'
  AND ts.trades_count IS NULL;

-- 90D -> 7D
UPDATE trader_snapshots ts
SET trades_count = GREATEST(1, ROUND(ref.trades_count * 7.0 / 90))
FROM trader_snapshots ref
WHERE ts.source = ref.source
  AND ts.source_trader_id = ref.source_trader_id
  AND ref.season_id = '90D'
  AND ref.trades_count IS NOT NULL
  AND ts.season_id = '7D'
  AND ts.trades_count IS NULL;

-- 30D -> 90D
UPDATE trader_snapshots ts
SET trades_count = GREATEST(1, ROUND(ref.trades_count * 90.0 / 30))
FROM trader_snapshots ref
WHERE ts.source = ref.source
  AND ts.source_trader_id = ref.source_trader_id
  AND ref.season_id = '30D'
  AND ref.trades_count IS NOT NULL
  AND ts.season_id = '90D'
  AND ts.trades_count IS NULL;

-- 30D -> 7D
UPDATE trader_snapshots ts
SET trades_count = GREATEST(1, ROUND(ref.trades_count * 7.0 / 30))
FROM trader_snapshots ref
WHERE ts.source = ref.source
  AND ts.source_trader_id = ref.source_trader_id
  AND ref.season_id = '30D'
  AND ref.trades_count IS NOT NULL
  AND ts.season_id = '7D'
  AND ts.trades_count IS NULL;

-- 7D -> 30D
UPDATE trader_snapshots ts
SET trades_count = GREATEST(1, ROUND(ref.trades_count * 30.0 / 7))
FROM trader_snapshots ref
WHERE ts.source = ref.source
  AND ts.source_trader_id = ref.source_trader_id
  AND ref.season_id = '7D'
  AND ref.trades_count IS NOT NULL
  AND ts.season_id = '30D'
  AND ts.trades_count IS NULL;

-- 7D -> 90D
UPDATE trader_snapshots ts
SET trades_count = GREATEST(1, ROUND(ref.trades_count * 90.0 / 7))
FROM trader_snapshots ref
WHERE ts.source = ref.source
  AND ts.source_trader_id = ref.source_trader_id
  AND ref.season_id = '7D'
  AND ref.trades_count IS NOT NULL
  AND ts.season_id = '90D'
  AND ts.trades_count IS NULL;
