-- 添加测试交易员数据
-- 在 Supabase SQL Editor 中运行此脚本

-- 1. 先添加 trader_sources（交易员基本信息）
INSERT INTO trader_sources (source, source_trader_id, handle, profile_url)
VALUES 
  ('binance', 'BTC_WHALE_001', 'BitcoinWhale', 'https://api.dicebear.com/7.x/avataaars/svg?seed=whale'),
  ('binance', 'ETH_MASTER_002', 'EthereumMaster', 'https://api.dicebear.com/7.x/avataaars/svg?seed=eth'),
  ('binance', 'CRYPTO_KING_003', 'CryptoKing', 'https://api.dicebear.com/7.x/avataaars/svg?seed=king'),
  ('binance', 'MOON_TRADER_004', 'MoonTrader', 'https://api.dicebear.com/7.x/avataaars/svg?seed=moon'),
  ('binance', 'DIAMOND_HANDS_005', 'DiamondHands', 'https://api.dicebear.com/7.x/avataaars/svg?seed=diamond'),
  ('binance', 'ALPHA_HUNTER_006', 'AlphaHunter', 'https://api.dicebear.com/7.x/avataaars/svg?seed=alpha'),
  ('binance', 'DEFI_PRO_007', 'DeFiPro', 'https://api.dicebear.com/7.x/avataaars/svg?seed=defi'),
  ('binance', 'SWING_MASTER_008', 'SwingMaster', 'https://api.dicebear.com/7.x/avataaars/svg?seed=swing'),
  ('binance', 'QUANT_BOT_009', 'QuantBot', 'https://api.dicebear.com/7.x/avataaars/svg?seed=quant'),
  ('binance', 'RISK_MANAGER_010', 'RiskManager', 'https://api.dicebear.com/7.x/avataaars/svg?seed=risk')
ON CONFLICT (source, source_trader_id) DO UPDATE SET
  handle = EXCLUDED.handle,
  profile_url = EXCLUDED.profile_url;

-- 2. 添加 trader_snapshots（交易员快照数据 - 排行榜用）
INSERT INTO trader_snapshots (source, source_trader_id, rank, roi, pnl, followers, win_rate, captured_at)
VALUES 
  ('binance', 'BTC_WHALE_001', 1, 285.67, 1250000, 15680, 0.72, NOW()),
  ('binance', 'ETH_MASTER_002', 2, 198.34, 890000, 12450, 0.68, NOW()),
  ('binance', 'CRYPTO_KING_003', 3, 156.89, 720000, 9870, 0.71, NOW()),
  ('binance', 'MOON_TRADER_004', 4, 134.56, 560000, 8540, 0.65, NOW()),
  ('binance', 'DIAMOND_HANDS_005', 5, 112.23, 480000, 7230, 0.69, NOW()),
  ('binance', 'ALPHA_HUNTER_006', 6, 98.45, 390000, 6120, 0.64, NOW()),
  ('binance', 'DEFI_PRO_007', 7, 87.12, 320000, 5430, 0.67, NOW()),
  ('binance', 'SWING_MASTER_008', 8, 76.89, 270000, 4890, 0.62, NOW()),
  ('binance', 'QUANT_BOT_009', 9, 65.34, 210000, 4120, 0.70, NOW()),
  ('binance', 'RISK_MANAGER_010', 10, 54.67, 180000, 3560, 0.73, NOW());

-- 3. 验证数据
SELECT 
  ts.rank,
  ts.source_trader_id,
  s.handle,
  ts.roi,
  ts.followers,
  ts.win_rate
FROM trader_snapshots ts
LEFT JOIN trader_sources s ON ts.source = s.source AND ts.source_trader_id = s.source_trader_id
WHERE ts.source = 'binance'
ORDER BY ts.rank;


