-- Arena Connector Migration — Production Data Verification
-- Run in Supabase SQL Editor after deployment
-- 2026-03-13

-- ============================================
-- 1. 数据新鲜度（每个平台最近一次更新）
-- ============================================
SELECT source as platform,
  MAX(captured_at) as last_update,
  NOW() - MAX(captured_at) as staleness,
  COUNT(*) FILTER (WHERE captured_at > NOW() - INTERVAL '24 hours') as last_24h_count
FROM trader_snapshots
WHERE source NOT IN ('bybit','bybit_spot','kucoin','weex','perpetual_protocol','lbank',
  'bitget_spot','mux','synthetix','paradex','kwenta','blofin','okx_spot','bitmart','whitebit','btse')
GROUP BY source
ORDER BY last_update ASC;

-- ============================================
-- 2. 字段完整性（最近 48h 的 NULL 比例）
-- ============================================
SELECT source as platform,
  COUNT(*) as total,
  ROUND(100.0 * SUM(CASE WHEN roi IS NULL THEN 1 ELSE 0 END) / COUNT(*), 1) as null_roi_pct,
  ROUND(100.0 * SUM(CASE WHEN pnl IS NULL THEN 1 ELSE 0 END) / COUNT(*), 1) as null_pnl_pct,
  ROUND(100.0 * SUM(CASE WHEN win_rate IS NULL THEN 1 ELSE 0 END) / COUNT(*), 1) as null_winrate_pct,
  ROUND(100.0 * SUM(CASE WHEN max_drawdown IS NULL THEN 1 ELSE 0 END) / COUNT(*), 1) as null_mdd_pct
FROM trader_snapshots
WHERE captured_at > NOW() - INTERVAL '48 hours'
  AND source NOT IN ('bybit','bybit_spot','kucoin','weex','perpetual_protocol','lbank',
    'bitget_spot','mux','synthetix','paradex','kwenta','blofin','okx_spot','bitmart','whitebit','btse')
GROUP BY source
ORDER BY null_roi_pct DESC;

-- ============================================
-- 3. 异常值检测（最近 48h）
-- ============================================
SELECT source as platform, source_trader_id as trader_key,
  season_id as period, roi, pnl, win_rate, max_drawdown, captured_at
FROM trader_snapshots
WHERE captured_at > NOW() - INTERVAL '48 hours'
  AND (roi > 50000 OR roi < -100
    OR pnl > 100000000
    OR win_rate > 100 OR win_rate < 0
    OR max_drawdown > 100 OR max_drawdown < 0)
ORDER BY captured_at DESC
LIMIT 50;

-- ============================================
-- 4. 重复数据检测（最近 48h）
-- ============================================
SELECT source, source_trader_id, season_id,
  DATE_TRUNC('hour', captured_at) as hour_bucket,
  COUNT(*) as dupes
FROM trader_snapshots
WHERE captured_at > NOW() - INTERVAL '48 hours'
GROUP BY source, source_trader_id, season_id, DATE_TRUNC('hour', captured_at)
HAVING COUNT(*) > 1
ORDER BY dupes DESC
LIMIT 30;

-- ============================================
-- 5. Arena Score 抽样验算（10 个 trader）
-- ============================================
SELECT lr.source as platform, lr.source_trader_id as trader_key,
  lr.season_id as period, lr.arena_score as db_score,
  snap.roi, snap.pnl, snap.win_rate, snap.max_drawdown
FROM leaderboard_ranks lr
JOIN trader_snapshots snap
  ON lr.source = snap.source
  AND lr.source_trader_id = snap.source_trader_id
  AND lr.season_id = snap.season_id
WHERE lr.season_id = '90D'
  AND snap.captured_at > NOW() - INTERVAL '48 hours'
  AND snap.roi IS NOT NULL
ORDER BY RANDOM()
LIMIT 10;

-- ============================================
-- 6. 4 表一致性检查
-- ============================================
-- trader_sources 中有但 trader_snapshots 中没有最近数据的平台
SELECT ts.source, COUNT(*) as orphan_sources
FROM trader_sources ts
LEFT JOIN trader_snapshots snap
  ON ts.source = snap.source
  AND ts.source_trader_id = snap.source_trader_id
  AND snap.captured_at > NOW() - INTERVAL '48 hours'
WHERE snap.id IS NULL
  AND ts.source NOT IN ('bybit','bybit_spot','kucoin','weex','perpetual_protocol','lbank',
    'bitget_spot','mux','synthetix','paradex','kwenta','blofin','okx_spot','bitmart','whitebit','btse')
  AND ts.is_active = true
GROUP BY ts.source
ORDER BY orphan_sources DESC;
