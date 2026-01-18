-- ============================================
-- Source 字段迁移脚本
-- 将现有的 source 字段重命名，区分 futures/spot/web3
-- ============================================

-- 1. 备份现有数据（可选，建议在执行前手动备份）
-- CREATE TABLE trader_snapshots_backup AS SELECT * FROM trader_snapshots;
-- CREATE TABLE trader_sources_backup AS SELECT * FROM trader_sources;

-- 2. 更新 trader_snapshots 表的 source 字段
-- binance -> binance_futures (合约)
UPDATE trader_snapshots 
SET source = 'binance_futures' 
WHERE source = 'binance';

-- bitget -> bitget_futures (合约)
UPDATE trader_snapshots 
SET source = 'bitget_futures' 
WHERE source = 'bitget';

-- 3. 更新 trader_sources 表的 source 字段
-- binance -> binance_futures
UPDATE trader_sources 
SET source = 'binance_futures' 
WHERE source = 'binance';

-- bitget -> bitget_futures
UPDATE trader_sources 
SET source = 'bitget_futures' 
WHERE source = 'bitget';

-- 4. 验证迁移结果
SELECT source, COUNT(*) as count 
FROM trader_snapshots 
GROUP BY source 
ORDER BY source;

SELECT source, COUNT(*) as count 
FROM trader_sources 
GROUP BY source 
ORDER BY source;

-- 5. 创建 source 类型映射表（用于前端显示）
CREATE TABLE IF NOT EXISTS source_metadata (
  source TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('futures', 'spot', 'web3')),
  platform TEXT NOT NULL,
  leaderboard_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. 插入所有数据源的元数据
INSERT INTO source_metadata (source, display_name, source_type, platform, leaderboard_url) VALUES
  ('binance_futures', 'Binance Futures', 'futures', 'Binance', 'https://www.binance.com/en/copy-trading'),
  ('binance_spot', 'Binance Spot', 'spot', 'Binance', 'https://www.binance.com/en/copy-trading/spot'),
  ('binance_web3', 'Binance Web3', 'web3', 'Binance', 'https://web3.binance.com/zh-CN/leaderboard'),
  ('bybit', 'Bybit', 'futures', 'Bybit', 'https://www.bybit.com/copyTrade/'),
  ('bitget_futures', 'Bitget Futures', 'futures', 'Bitget', 'https://www.bitget.com/asia/copy-trading/futures/all'),
  ('bitget_spot', 'Bitget Spot', 'spot', 'Bitget', 'https://www.bitget.com/asia/copy-trading/spot'),
  ('mexc', 'MEXC', 'futures', 'MEXC', 'https://www.mexc.com/futures/copyTrade/home'),
  ('coinex', 'CoinEx', 'futures', 'CoinEx', 'https://www.coinex.com/en/copy-trading/futures'),
  ('okx_web3', 'OKX Web3', 'web3', 'OKX', 'https://web3.okx.com/zh-hans/copy-trade/leaderboard/solana'),
  ('kucoin', 'KuCoin', 'futures', 'KuCoin', 'https://www.kucoin.com/copytrading'),
  ('gmx', 'GMX', 'web3', 'GMX', 'https://app.gmx.io/#/leaderboard')
ON CONFLICT (source) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  source_type = EXCLUDED.source_type,
  platform = EXCLUDED.platform,
  leaderboard_url = EXCLUDED.leaderboard_url;

-- 7. 创建索引优化查询
CREATE INDEX IF NOT EXISTS idx_source_metadata_type ON source_metadata(source_type);
CREATE INDEX IF NOT EXISTS idx_source_metadata_platform ON source_metadata(platform);
