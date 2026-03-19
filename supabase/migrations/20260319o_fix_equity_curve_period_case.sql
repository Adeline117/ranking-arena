-- Fix lowercase period values in trader_equity_curve
-- KuCoin Mac Mini script was writing '30d' instead of '30D', '7d' instead of '7D'
-- The enrichment queries use uppercase period values (e.g., eq(ENRICH.period, '30D'))

UPDATE trader_equity_curve SET period = '30D' WHERE period = '30d';
UPDATE trader_equity_curve SET period = '7D' WHERE period = '7d';
UPDATE trader_equity_curve SET period = '90D' WHERE period = '90d';

-- Also fix any lowercase in trader_stats_detail
UPDATE trader_stats_detail SET period = '30D' WHERE period = '30d';
UPDATE trader_stats_detail SET period = '7D' WHERE period = '7d';
UPDATE trader_stats_detail SET period = '90D' WHERE period = '90d';

-- Also fix any lowercase window in trader_snapshots_v2 (Mac Mini historical data)
UPDATE trader_snapshots_v2 SET window = '30D' WHERE window = '30d';
UPDATE trader_snapshots_v2 SET window = '7D' WHERE window = '7d';
UPDATE trader_snapshots_v2 SET window = '90D' WHERE window = '90d';
