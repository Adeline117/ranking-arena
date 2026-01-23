-- Seed verification data for multi-exchange leaderboard runtime proof
-- Generates realistic synthetic data for Binance, Bybit, Bitget, OKX, MEXC futures

BEGIN;

-- ==========================================
-- 1. TRADER SOURCES (discovery layer)
-- ==========================================

-- Binance Futures traders (20 traders)
INSERT INTO trader_sources (source, source_trader_id, nickname, market_type, roi, pnl, win_rate, max_drawdown, followers, trades_count, rank, season_id, is_active, display_name, discovered_at, last_seen_at, raw)
VALUES
  ('binance', 'BN_3A9F2C01', 'CryptoAlpha', 'futures', 342.15, 285430.50, 72.30, -12.45, 15420, 1823, 1, '30D', true, 'CryptoAlpha', NOW(), NOW(), '{"encryptedUid":"BN_3A9F2C01"}'),
  ('binance', 'BN_7B1E4D02', 'WhaleMaster', 'futures', 289.67, 198200.00, 68.50, -15.20, 12300, 956, 2, '30D', true, 'WhaleMaster', NOW(), NOW(), '{"encryptedUid":"BN_7B1E4D02"}'),
  ('binance', 'BN_5C2F8A03', 'DeltaTrader', 'futures', 245.89, 167800.75, 71.80, -9.30, 9870, 2104, 3, '30D', true, 'DeltaTrader', NOW(), NOW(), '{"encryptedUid":"BN_5C2F8A03"}'),
  ('binance', 'BN_2D4E6B04', 'AlphaQuant', 'futures', 198.34, 145600.25, 65.40, -18.70, 8540, 1567, 4, '30D', true, 'AlphaQuant', NOW(), NOW(), '{"encryptedUid":"BN_2D4E6B04"}'),
  ('binance', 'BN_9F1A3C05', 'BullRunner', 'futures', 187.56, 132400.00, 69.20, -14.10, 7650, 1234, 5, '30D', true, 'BullRunner', NOW(), NOW(), '{"encryptedUid":"BN_9F1A3C05"}'),
  ('binance', 'BN_4E7B2D06', 'MomentumKing', 'futures', 165.23, 98750.50, 63.80, -21.40, 6230, 890, 6, '30D', true, 'MomentumKing', NOW(), NOW(), '{"encryptedUid":"BN_4E7B2D06"}'),
  ('binance', 'BN_8C3D5F07', 'ScalpMaster', 'futures', 152.78, 87600.25, 77.60, -8.90, 5420, 4521, 7, '30D', true, 'ScalpMaster', NOW(), NOW(), '{"encryptedUid":"BN_8C3D5F07"}'),
  ('binance', 'BN_1A6E9B08', 'TrendSurfer', 'futures', 143.45, 76500.00, 61.20, -22.30, 4890, 678, 8, '30D', true, 'TrendSurfer', NOW(), NOW(), '{"encryptedUid":"BN_1A6E9B08"}'),
  ('binance', 'BN_6F2C4A09', 'GridBot99', 'futures', 128.90, 65200.75, 82.10, -6.50, 4230, 8923, 9, '30D', true, 'GridBot99', NOW(), NOW(), '{"encryptedUid":"BN_6F2C4A09"}'),
  ('binance', 'BN_3B8D7E10', 'SwingPro', 'futures', 118.56, 54300.50, 58.90, -25.60, 3870, 456, 10, '30D', true, 'SwingPro', NOW(), NOW(), '{"encryptedUid":"BN_3B8D7E10"}'),
  ('binance', 'BN_7A4F1C11', 'LeverageKing', 'futures', 105.23, 48900.00, 55.40, -32.10, 3450, 789, 11, '30D', true, 'LeverageKing', NOW(), NOW(), '{"encryptedUid":"BN_7A4F1C11"}'),
  ('binance', 'BN_2E9B5D12', 'PatienceTrader', 'futures', 98.67, 42100.25, 74.30, -7.80, 3120, 234, 12, '30D', true, 'PatienceTrader', NOW(), NOW(), '{"encryptedUid":"BN_2E9B5D12"}'),
  ('binance', 'BN_5C1A8F13', 'NightOwl', 'futures', 87.45, 38700.50, 66.70, -16.40, 2890, 1456, 13, '30D', true, 'NightOwl', NOW(), NOW(), '{"encryptedUid":"BN_5C1A8F13"}'),
  ('binance', 'BN_8D3E2B14', 'ContrarianPro', 'futures', 76.89, 32400.00, 52.10, -28.90, 2650, 567, 14, '30D', true, 'ContrarianPro', NOW(), NOW(), '{"encryptedUid":"BN_8D3E2B14"}'),
  ('binance', 'BN_4F7C6A15', 'SmartMoney', 'futures', 65.34, 28900.75, 70.80, -11.20, 2340, 890, 15, '30D', true, 'SmartMoney', NOW(), NOW(), '{"encryptedUid":"BN_4F7C6A15"}'),
  ('binance', 'BN_1B5D9E16', 'BTCMaxi', 'futures', 54.12, 24500.50, 64.50, -19.80, 2100, 345, 16, '30D', true, 'BTCMaxi', NOW(), NOW(), '{"encryptedUid":"BN_1B5D9E16"}'),
  ('binance', 'BN_9A2F4C17', 'ETHBull', 'futures', 45.78, 19800.25, 59.30, -23.40, 1890, 678, 17, '30D', true, 'ETHBull', NOW(), NOW(), '{"encryptedUid":"BN_9A2F4C17"}'),
  ('binance', 'BN_6E8B1D18', 'AltSeason', 'futures', 38.45, 15600.00, 56.80, -27.60, 1650, 1234, 18, '30D', true, 'AltSeason', NOW(), NOW(), '{"encryptedUid":"BN_6E8B1D18"}'),
  ('binance', 'BN_3C7A5F19', 'DCAKing', 'futures', 28.90, 12400.50, 80.20, -5.30, 1420, 156, 19, '30D', true, 'DCAKing', NOW(), NOW(), '{"encryptedUid":"BN_3C7A5F19"}'),
  ('binance', 'BN_8F4E2B20', 'FOMOHunter', 'futures', 22.34, 8900.75, 48.60, -35.20, 1200, 2345, 20, '30D', true, 'FOMOHunter', NOW(), NOW(), '{"encryptedUid":"BN_8F4E2B20"}');

-- Bybit Futures traders (15 traders)
INSERT INTO trader_sources (source, source_trader_id, nickname, market_type, roi, pnl, win_rate, max_drawdown, followers, trades_count, rank, season_id, is_active, display_name, discovered_at, last_seen_at, raw)
VALUES
  ('bybit', 'BY_A1B2C301', 'BybitWhale', 'futures', 412.50, 356000.00, 74.20, -10.80, 18900, 1456, 1, '30D', true, 'BybitWhale', NOW(), NOW(), '{}'),
  ('bybit', 'BY_D4E5F602', 'SniperEntry', 'futures', 298.30, 245000.50, 69.80, -13.50, 14200, 2345, 2, '30D', true, 'SniperEntry', NOW(), NOW(), '{}'),
  ('bybit', 'BY_G7H8I903', 'MartingaleBot', 'futures', 256.78, 198000.25, 85.40, -7.20, 11800, 6789, 3, '30D', true, 'MartingaleBot', NOW(), NOW(), '{}'),
  ('bybit', 'BY_J1K2L304', 'TrendFollower', 'futures', 198.45, 156000.00, 62.30, -19.80, 9500, 890, 4, '30D', true, 'TrendFollower', NOW(), NOW(), '{}'),
  ('bybit', 'BY_M4N5O605', 'GridMaster', 'futures', 167.23, 128000.75, 78.90, -8.40, 7800, 5678, 5, '30D', true, 'GridMaster', NOW(), NOW(), '{}'),
  ('bybit', 'BY_P7Q8R906', 'VolatilityHunter', 'futures', 145.67, 98000.50, 58.60, -24.30, 6200, 1234, 6, '30D', true, 'VolatilityHunter', NOW(), NOW(), '{}'),
  ('bybit', 'BY_S1T2U307', 'PatternTrader', 'futures', 123.89, 78000.25, 66.40, -17.50, 5100, 2345, 7, '30D', true, 'PatternTrader', NOW(), NOW(), '{}'),
  ('bybit', 'BY_V4W5X608', 'ArbitrageKing', 'futures', 105.34, 65000.00, 92.10, -3.80, 4300, 12345, 8, '30D', true, 'ArbitrageKing', NOW(), NOW(), '{}'),
  ('bybit', 'BY_Y7Z8A909', 'MacroTrader', 'futures', 89.56, 52000.75, 54.20, -28.90, 3600, 456, 9, '30D', true, 'MacroTrader', NOW(), NOW(), '{}'),
  ('bybit', 'BY_B1C2D310', 'RiskManager', 'futures', 76.78, 42000.50, 71.80, -9.60, 2900, 789, 10, '30D', true, 'RiskManager', NOW(), NOW(), '{}'),
  ('bybit', 'BY_E4F5G611', 'NewsTrader', 'futures', 65.12, 35000.25, 60.30, -20.40, 2400, 3456, 11, '30D', true, 'NewsTrader', NOW(), NOW(), '{}'),
  ('bybit', 'BY_H7I8J912', 'FundingArb', 'futures', 54.34, 28000.00, 88.70, -4.50, 1900, 7890, 12, '30D', true, 'FundingArb', NOW(), NOW(), '{}'),
  ('bybit', 'BY_K1L2M313', 'BreakoutHunter', 'futures', 43.67, 22000.75, 55.80, -26.70, 1500, 1678, 13, '30D', true, 'BreakoutHunter', NOW(), NOW(), '{}'),
  ('bybit', 'BY_N4O5P614', 'RangeTrader', 'futures', 32.89, 18000.50, 73.40, -11.30, 1200, 2345, 14, '30D', true, 'RangeTrader', NOW(), NOW(), '{}'),
  ('bybit', 'BY_Q7R8S915', 'Scalper3000', 'futures', 25.12, 14000.25, 80.60, -6.80, 950, 9876, 15, '30D', true, 'Scalper3000', NOW(), NOW(), '{}');

-- Bitget Futures traders (10 traders)
INSERT INTO trader_sources (source, source_trader_id, nickname, market_type, roi, pnl, win_rate, max_drawdown, followers, trades_count, rank, season_id, is_active, display_name, discovered_at, last_seen_at, raw)
VALUES
  ('bitget', 'BG_X1Y2Z301', 'BitgetStar', 'futures', 378.90, 312000.00, 73.50, -11.20, 22100, 1890, 1, '30D', true, 'BitgetStar', NOW(), NOW(), '{}'),
  ('bitget', 'BG_A4B5C602', 'CopyLeader1', 'futures', 267.45, 215000.50, 70.20, -14.80, 16500, 2567, 2, '30D', true, 'CopyLeader1', NOW(), NOW(), '{}'),
  ('bitget', 'BG_D7E8F903', 'FuturesPro', 'futures', 212.30, 175000.25, 67.80, -16.90, 12800, 1234, 3, '30D', true, 'FuturesPro', NOW(), NOW(), '{}'),
  ('bitget', 'BG_G1H2I304', 'OrderFlow', 'futures', 178.67, 142000.00, 65.40, -19.30, 9600, 3456, 4, '30D', true, 'OrderFlow', NOW(), NOW(), '{}'),
  ('bitget', 'BG_J4K5L605', 'LiqHunter', 'futures', 145.23, 108000.75, 62.10, -22.50, 7200, 2890, 5, '30D', true, 'LiqHunter', NOW(), NOW(), '{}'),
  ('bitget', 'BG_M7N8O906', 'DeFiWhale', 'futures', 112.56, 85000.50, 59.80, -25.70, 5400, 1567, 6, '30D', true, 'DeFiWhale', NOW(), NOW(), '{}'),
  ('bitget', 'BG_P1Q2R307', 'TechAnalyst', 'futures', 89.34, 62000.25, 72.60, -10.40, 4100, 890, 7, '30D', true, 'TechAnalyst', NOW(), NOW(), '{}'),
  ('bitget', 'BG_S4T5U608', 'MeanReversion', 'futures', 67.89, 45000.00, 76.30, -8.60, 3200, 4567, 8, '30D', true, 'MeanReversion', NOW(), NOW(), '{}'),
  ('bitget', 'BG_V7W8X909', 'BotBuilder', 'futures', 45.12, 32000.75, 83.90, -5.20, 2500, 8901, 9, '30D', true, 'BotBuilder', NOW(), NOW(), '{}'),
  ('bitget', 'BG_Y1Z2A310', 'CryptoNinja', 'futures', 34.56, 24000.50, 57.40, -29.80, 1800, 1234, 10, '30D', true, 'CryptoNinja', NOW(), NOW(), '{}');

-- OKX Futures traders (10 traders)
INSERT INTO trader_sources (source, source_trader_id, nickname, market_type, roi, pnl, win_rate, max_drawdown, followers, trades_count, rank, season_id, is_active, display_name, discovered_at, last_seen_at, raw)
VALUES
  ('okx', 'OKX_1A2B3C01', 'OKXChampion', 'futures', 356.78, 298000.00, 71.90, -12.30, 19800, 2345, 1, '30D', true, 'OKXChampion', NOW(), NOW(), '{}'),
  ('okx', 'OKX_4D5E6F02', 'PerpKing', 'futures', 278.45, 225000.50, 68.40, -15.70, 14500, 1678, 2, '30D', true, 'PerpKing', NOW(), NOW(), '{}'),
  ('okx', 'OKX_7G8H9I03', 'OKXElite', 'futures', 223.12, 178000.25, 66.20, -18.40, 10200, 2890, 3, '30D', true, 'OKXElite', NOW(), NOW(), '{}'),
  ('okx', 'OKX_1J2K3L04', 'FundingBot', 'futures', 189.67, 145000.00, 90.10, -4.20, 7800, 10234, 4, '30D', true, 'FundingBot', NOW(), NOW(), '{}'),
  ('okx', 'OKX_4M5N6O05', 'VolumeTrader', 'futures', 156.34, 112000.75, 63.80, -21.60, 5900, 5678, 5, '30D', true, 'VolumeTrader', NOW(), NOW(), '{}'),
  ('okx', 'OKX_7P8Q9R06', 'SmartLev', 'futures', 123.89, 89000.50, 60.50, -24.30, 4500, 1234, 6, '30D', true, 'SmartLev', NOW(), NOW(), '{}'),
  ('okx', 'OKX_1S2T3U07', 'BasisTrader', 'futures', 98.56, 67000.25, 85.20, -6.80, 3400, 6789, 7, '30D', true, 'BasisTrader', NOW(), NOW(), '{}'),
  ('okx', 'OKX_4V5W6X08', 'LongTermBull', 'futures', 76.23, 52000.00, 55.90, -28.40, 2600, 345, 8, '30D', true, 'LongTermBull', NOW(), NOW(), '{}'),
  ('okx', 'OKX_7Y8Z9A09', 'ShortSeller', 'futures', 54.89, 38000.75, 58.30, -26.90, 1900, 890, 9, '30D', true, 'ShortSeller', NOW(), NOW(), '{}'),
  ('okx', 'OKX_1B2C3D10', 'HedgeFund', 'futures', 42.34, 28000.50, 75.60, -9.10, 1400, 1567, 10, '30D', true, 'HedgeFund', NOW(), NOW(), '{}');

-- MEXC Futures traders (10 traders)
INSERT INTO trader_sources (source, source_trader_id, nickname, market_type, roi, pnl, win_rate, max_drawdown, followers, trades_count, rank, season_id, is_active, display_name, discovered_at, last_seen_at, raw)
VALUES
  ('mexc', 'MX_A1B2C301', 'MEXCWhale', 'futures', 289.45, 198000.00, 67.80, -16.50, 8900, 2345, 1, '30D', true, 'MEXCWhale', NOW(), NOW(), '{}'),
  ('mexc', 'MX_D4E5F602', 'AltCoinPro', 'futures', 234.12, 167000.50, 64.30, -19.20, 6700, 3456, 2, '30D', true, 'AltCoinPro', NOW(), NOW(), '{}'),
  ('mexc', 'MX_G7H8I903', 'MemeCoinHunter', 'futures', 198.78, 134000.25, 52.10, -32.40, 5400, 4567, 3, '30D', true, 'MemeCoinHunter', NOW(), NOW(), '{}'),
  ('mexc', 'MX_J1K2L304', 'MEXCScalper', 'futures', 156.34, 102000.00, 79.60, -7.80, 4200, 8901, 4, '30D', true, 'MEXCScalper', NOW(), NOW(), '{}'),
  ('mexc', 'MX_M4N5O605', 'LowCapGems', 'futures', 123.67, 78000.75, 55.40, -28.60, 3100, 2345, 5, '30D', true, 'LowCapGems', NOW(), NOW(), '{}'),
  ('mexc', 'MX_P7Q8R906', 'MEXCBot', 'futures', 98.23, 56000.50, 86.30, -5.10, 2400, 12345, 6, '30D', true, 'MEXCBot', NOW(), NOW(), '{}'),
  ('mexc', 'MX_S1T2U307', 'ShitcoinDegenerate', 'futures', 78.56, 42000.25, 45.80, -38.90, 1800, 5678, 7, '30D', true, 'ShitcoinDegenerate', NOW(), NOW(), '{}'),
  ('mexc', 'MX_V4W5X608', 'SafeTrader', 'futures', 56.89, 32000.00, 78.20, -8.30, 1400, 1234, 8, '30D', true, 'SafeTrader', NOW(), NOW(), '{}'),
  ('mexc', 'MX_Y7Z8A909', 'NightShift', 'futures', 34.12, 22000.75, 62.50, -20.70, 1050, 2345, 9, '30D', true, 'NightShift', NOW(), NOW(), '{}'),
  ('mexc', 'MX_B1C2D310', 'MEXCNewbie', 'futures', 18.45, 12000.50, 50.30, -34.20, 780, 890, 10, '30D', true, 'MEXCNewbie', NOW(), NOW(), '{}');

-- ==========================================
-- 2. TRADER SNAPSHOTS (performance data per window)
-- ==========================================

-- Helper function to compute arena_score
-- arena_score = return_score + drawdown_score + stability_score
-- return_score: min(roi / 5, 85) capped at 85
-- drawdown_score: max(0, 8 - abs(max_drawdown) / 5) capped at 8
-- stability_score: min(win_rate / 15, 7) capped at 7

-- Binance Futures snapshots (30d window for all 20 traders)
INSERT INTO trader_snapshots (source, source_trader_id, nickname, roi, pnl, win_rate, max_drawdown, followers, trades_count, rank, season_id, arena_score, market_type, "window", as_of_ts, metrics, quality_flags, return_score, drawdown_score, stability_score)
VALUES
  ('binance', 'BN_3A9F2C01', 'CryptoAlpha', 342.15, 285430.50, 72.30, -12.45, 15420, 1823, 1, '30D', 93.31, 'futures', '30d', NOW(), '{"roi":342.15,"pnl":285430.50,"win_rate":72.30,"max_drawdown":-12.45}', '{"window_native":true}', 85.00, 5.51, 4.82),
  ('binance', 'BN_7B1E4D02', 'WhaleMaster', 289.67, 198200.00, 68.50, -15.20, 12300, 956, 2, '30D', 90.57, 'futures', '30d', NOW(), '{"roi":289.67,"pnl":198200.00,"win_rate":68.50,"max_drawdown":-15.20}', '{"window_native":true}', 85.00, 4.96, 4.57),
  ('binance', 'BN_5C2F8A03', 'DeltaTrader', 245.89, 167800.75, 71.80, -9.30, 9870, 2104, 3, '30D', 93.94, 'futures', '30d', NOW(), '{"roi":245.89,"pnl":167800.75,"win_rate":71.80,"max_drawdown":-9.30}', '{"window_native":true}', 85.00, 6.14, 4.79),
  ('binance', 'BN_2D4E6B04', 'AlphaQuant', 198.34, 145600.25, 65.40, -18.70, 8540, 1567, 4, '30D', 88.62, 'futures', '30d', NOW(), '{"roi":198.34,"pnl":145600.25,"win_rate":65.40,"max_drawdown":-18.70}', '{"window_native":true}', 85.00, 4.26, 4.36),
  ('binance', 'BN_9F1A3C05', 'BullRunner', 187.56, 132400.00, 69.20, -14.10, 7650, 1234, 5, '30D', 91.36, 'futures', '30d', NOW(), '{"roi":187.56,"pnl":132400.00,"win_rate":69.20,"max_drawdown":-14.10}', '{"window_native":true}', 85.00, 5.18, 4.61),
  ('binance', 'BN_4E7B2D06', 'MomentumKing', 165.23, 98750.50, 63.80, -21.40, 6230, 890, 6, '30D', 86.97, 'futures', '30d', NOW(), '{"roi":165.23,"pnl":98750.50,"win_rate":63.80,"max_drawdown":-21.40}', '{"window_native":true}', 85.00, 3.72, 4.25),
  ('binance', 'BN_8C3D5F07', 'ScalpMaster', 152.78, 87600.25, 77.60, -8.90, 5420, 4521, 7, '30D', 94.39, 'futures', '30d', NOW(), '{"roi":152.78,"pnl":87600.25,"win_rate":77.60,"max_drawdown":-8.90}', '{"window_native":true}', 85.00, 6.22, 5.17),
  ('binance', 'BN_1A6E9B08', 'TrendSurfer', 143.45, 76500.00, 61.20, -22.30, 4890, 678, 8, '30D', 86.14, 'futures', '30d', NOW(), '{"roi":143.45,"pnl":76500.00,"win_rate":61.20,"max_drawdown":-22.30}', '{"window_native":true}', 85.00, 3.54, 4.08),
  ('binance', 'BN_6F2C4A09', 'GridBot99', 128.90, 65200.75, 82.10, -6.50, 4230, 8923, 9, '30D', 96.17, 'futures', '30d', NOW(), '{"roi":128.90,"pnl":65200.75,"win_rate":82.10,"max_drawdown":-6.50}', '{"window_native":true}', 85.00, 6.70, 5.47),
  ('binance', 'BN_3B8D7E10', 'SwingPro', 118.56, 54300.50, 58.90, -25.60, 3870, 456, 10, '30D', 83.81, 'futures', '30d', NOW(), '{"roi":118.56,"pnl":54300.50,"win_rate":58.90,"max_drawdown":-25.60}', '{"window_native":true}', 85.00, 2.88, 3.93),
  ('binance', 'BN_7A4F1C11', 'LeverageKing', 105.23, 48900.00, 55.40, -32.10, 3450, 789, 11, '30D', 79.97, 'futures', '30d', NOW(), '{"roi":105.23,"pnl":48900.00,"win_rate":55.40,"max_drawdown":-32.10}', '{"window_native":true}', 85.00, 1.58, 3.69),
  ('binance', 'BN_2E9B5D12', 'PatienceTrader', 98.67, 42100.25, 74.30, -7.80, 3120, 234, 12, '30D', 95.37, 'futures', '30d', NOW(), '{"roi":98.67,"pnl":42100.25,"win_rate":74.30,"max_drawdown":-7.80}', '{"window_native":true}', 85.00, 6.44, 4.95),
  ('binance', 'BN_5C1A8F13', 'NightOwl', 87.45, 38700.50, 66.70, -16.40, 2890, 1456, 13, '30D', 89.73, 'futures', '30d', NOW(), '{"roi":87.45,"pnl":38700.50,"win_rate":66.70,"max_drawdown":-16.40}', '{"window_native":true}', 85.00, 4.72, 4.45),
  ('binance', 'BN_8D3E2B14', 'ContrarianPro', 76.89, 32400.00, 52.10, -28.90, 2650, 567, 14, '30D', 82.40, 'futures', '30d', NOW(), '{"roi":76.89,"pnl":32400.00,"win_rate":52.10,"max_drawdown":-28.90}', '{"window_native":true}', 85.00, 2.22, 3.47),
  ('binance', 'BN_4F7C6A15', 'SmartMoney', 65.34, 28900.75, 70.80, -11.20, 2340, 890, 15, '30D', 92.52, 'futures', '30d', NOW(), '{"roi":65.34,"pnl":28900.75,"win_rate":70.80,"max_drawdown":-11.20}', '{"window_native":true}', 85.00, 5.76, 4.72),
  ('binance', 'BN_1B5D9E16', 'BTCMaxi', 54.12, 24500.50, 64.50, -19.80, 2100, 345, 16, '30D', 88.34, 'futures', '30d', NOW(), '{"roi":54.12,"pnl":24500.50,"win_rate":64.50,"max_drawdown":-19.80}', '{"window_native":true}', 85.00, 4.04, 4.30),
  ('binance', 'BN_9A2F4C17', 'ETHBull', 45.78, 19800.25, 59.30, -23.40, 1890, 678, 17, '30D', 85.73, 'futures', '30d', NOW(), '{"roi":45.78,"pnl":19800.25,"win_rate":59.30,"max_drawdown":-23.40}', '{"window_native":true}', 85.00, 3.32, 3.95),
  ('binance', 'BN_6E8B1D18', 'AltSeason', 38.45, 15600.00, 56.80, -27.60, 1650, 1234, 18, '30D', 83.26, 'futures', '30d', NOW(), '{"roi":38.45,"pnl":15600.00,"win_rate":56.80,"max_drawdown":-27.60}', '{"window_native":true}', 85.00, 2.48, 3.79),
  ('binance', 'BN_3C7A5F19', 'DCAKing', 28.90, 12400.50, 80.20, -5.30, 1420, 156, 19, '30D', 96.81, 'futures', '30d', NOW(), '{"roi":28.90,"pnl":12400.50,"win_rate":80.20,"max_drawdown":-5.30}', '{"window_native":true}', 85.00, 6.94, 5.35),
  ('binance', 'BN_8F4E2B20', 'FOMOHunter', 22.34, 8900.75, 48.60, -35.20, 1200, 2345, 20, '30D', 77.20, 'futures', '30d', NOW(), '{"roi":22.34,"pnl":8900.75,"win_rate":48.60,"max_drawdown":-35.20}', '{"window_native":true}', 85.00, 0.96, 3.24);

-- Bybit Futures snapshots (30d window, top 10)
INSERT INTO trader_snapshots (source, source_trader_id, nickname, roi, pnl, win_rate, max_drawdown, followers, trades_count, rank, season_id, arena_score, market_type, "window", as_of_ts, metrics, quality_flags, return_score, drawdown_score, stability_score)
VALUES
  ('bybit', 'BY_A1B2C301', 'BybitWhale', 412.50, 356000.00, 74.20, -10.80, 18900, 1456, 1, '30D', 93.79, 'futures', '30d', NOW(), '{"roi":412.50,"pnl":356000.00}', '{"window_native":true}', 85.00, 5.84, 4.95),
  ('bybit', 'BY_D4E5F602', 'SniperEntry', 298.30, 245000.50, 69.80, -13.50, 14200, 2345, 2, '30D', 91.35, 'futures', '30d', NOW(), '{"roi":298.30}', '{"window_native":true}', 85.00, 5.30, 4.65),
  ('bybit', 'BY_G7H8I903', 'MartingaleBot', 256.78, 198000.25, 85.40, -7.20, 11800, 6789, 3, '30D', 97.26, 'futures', '30d', NOW(), '{"roi":256.78}', '{"window_native":true}', 85.00, 6.56, 5.69),
  ('bybit', 'BY_J1K2L304', 'TrendFollower', 198.45, 156000.00, 62.30, -19.80, 9500, 890, 4, '30D', 87.19, 'futures', '30d', NOW(), '{"roi":198.45}', '{"window_native":true}', 85.00, 4.04, 4.15),
  ('bybit', 'BY_M4N5O605', 'GridMaster', 167.23, 128000.75, 78.90, -8.40, 7800, 5678, 5, '30D', 95.58, 'futures', '30d', NOW(), '{"roi":167.23}', '{"window_native":true}', 85.00, 6.32, 5.26),
  ('bybit', 'BY_P7Q8R906', 'VolatilityHunter', 145.67, 98000.50, 58.60, -24.30, 6200, 1234, 6, '30D', 83.78, 'futures', '30d', NOW(), '{"roi":145.67}', '{"window_native":true}', 85.00, 3.14, 3.91),
  ('bybit', 'BY_S1T2U307', 'PatternTrader', 123.89, 78000.25, 66.40, -17.50, 5100, 2345, 7, '30D', 89.93, 'futures', '30d', NOW(), '{"roi":123.89}', '{"window_native":true}', 85.00, 4.50, 4.43),
  ('bybit', 'BY_V4W5X608', 'ArbitrageKing', 105.34, 65000.00, 92.10, -3.80, 4300, 12345, 8, '30D', 98.38, 'futures', '30d', NOW(), '{"roi":105.34}', '{"window_native":true}', 85.00, 7.24, 6.14),
  ('bybit', 'BY_Y7Z8A909', 'MacroTrader', 89.56, 52000.75, 54.20, -28.90, 3600, 456, 9, '30D', 81.83, 'futures', '30d', NOW(), '{"roi":89.56}', '{"window_native":true}', 85.00, 2.22, 3.61),
  ('bybit', 'BY_B1C2D310', 'RiskManager', 76.78, 42000.50, 71.80, -9.60, 2900, 789, 10, '30D', 93.86, 'futures', '30d', NOW(), '{"roi":76.78}', '{"window_native":true}', 85.00, 6.08, 4.79);

-- Bitget Futures snapshots (30d window, top 10)
INSERT INTO trader_snapshots (source, source_trader_id, nickname, roi, pnl, win_rate, max_drawdown, followers, trades_count, rank, season_id, arena_score, market_type, "window", as_of_ts, metrics, quality_flags, return_score, drawdown_score, stability_score)
VALUES
  ('bitget', 'BG_X1Y2Z301', 'BitgetStar', 378.90, 312000.00, 73.50, -11.20, 22100, 1890, 1, '30D', 93.56, 'futures', '30d', NOW(), '{"roi":378.90}', '{"window_native":true}', 85.00, 5.76, 4.90),
  ('bitget', 'BG_A4B5C602', 'CopyLeader1', 267.45, 215000.50, 70.20, -14.80, 16500, 2567, 2, '30D', 90.72, 'futures', '30d', NOW(), '{"roi":267.45}', '{"window_native":true}', 85.00, 5.04, 4.68),
  ('bitget', 'BG_D7E8F903', 'FuturesPro', 212.30, 175000.25, 67.80, -16.90, 12800, 1234, 3, '30D', 89.14, 'futures', '30d', NOW(), '{"roi":212.30}', '{"window_native":true}', 85.00, 4.62, 4.52),
  ('bitget', 'BG_G1H2I304', 'OrderFlow', 178.67, 142000.00, 65.40, -19.30, 9600, 3456, 4, '30D', 87.50, 'futures', '30d', NOW(), '{"roi":178.67}', '{"window_native":true}', 85.00, 4.14, 4.36),
  ('bitget', 'BG_J4K5L605', 'LiqHunter', 145.23, 108000.75, 62.10, -22.50, 7200, 2890, 5, '30D', 85.64, 'futures', '30d', NOW(), '{"roi":145.23}', '{"window_native":true}', 85.00, 3.50, 4.14),
  ('bitget', 'BG_M7N8O906', 'DeFiWhale', 112.56, 85000.50, 59.80, -25.70, 5400, 1567, 6, '30D', 83.86, 'futures', '30d', NOW(), '{"roi":112.56}', '{"window_native":true}', 85.00, 2.86, 3.99),
  ('bitget', 'BG_P1Q2R307', 'TechAnalyst', 89.34, 62000.25, 72.60, -10.40, 4100, 890, 7, '30D', 93.76, 'futures', '30d', NOW(), '{"roi":89.34}', '{"window_native":true}', 85.00, 5.92, 4.84),
  ('bitget', 'BG_S4T5U608', 'MeanReversion', 67.89, 45000.00, 76.30, -8.60, 3200, 4567, 8, '30D', 95.17, 'futures', '30d', NOW(), '{"roi":67.89}', '{"window_native":true}', 85.00, 6.28, 5.09),
  ('bitget', 'BG_V7W8X909', 'BotBuilder', 45.12, 32000.75, 83.90, -5.20, 2500, 8901, 9, '30D', 97.56, 'futures', '30d', NOW(), '{"roi":45.12}', '{"window_native":true}', 85.00, 6.96, 5.59),
  ('bitget', 'BG_Y1Z2A310', 'CryptoNinja', 34.56, 24000.50, 57.40, -29.80, 1800, 1234, 10, '30D', 81.87, 'futures', '30d', NOW(), '{"roi":34.56}', '{"window_native":true}', 85.00, 2.04, 3.83);

-- OKX Futures snapshots (30d window, top 10)
INSERT INTO trader_snapshots (source, source_trader_id, nickname, roi, pnl, win_rate, max_drawdown, followers, trades_count, rank, season_id, arena_score, market_type, "window", as_of_ts, metrics, quality_flags, return_score, drawdown_score, stability_score)
VALUES
  ('okx', 'OKX_1A2B3C01', 'OKXChampion', 356.78, 298000.00, 71.90, -12.30, 19800, 2345, 1, '30D', 93.33, 'futures', '30d', NOW(), '{"roi":356.78}', '{"window_native":true}', 85.00, 5.54, 4.79),
  ('okx', 'OKX_4D5E6F02', 'PerpKing', 278.45, 225000.50, 68.40, -15.70, 14500, 1678, 2, '30D', 90.42, 'futures', '30d', NOW(), '{"roi":278.45}', '{"window_native":true}', 85.00, 4.86, 4.56),
  ('okx', 'OKX_7G8H9I03', 'OKXElite', 223.12, 178000.25, 66.20, -18.40, 10200, 2890, 3, '30D', 88.60, 'futures', '30d', NOW(), '{"roi":223.12}', '{"window_native":true}', 85.00, 4.32, 4.41),
  ('okx', 'OKX_1J2K3L04', 'FundingBot', 189.67, 145000.00, 90.10, -4.20, 7800, 10234, 4, '30D', 98.17, 'futures', '30d', NOW(), '{"roi":189.67}', '{"window_native":true}', 85.00, 7.16, 6.01),
  ('okx', 'OKX_4M5N6O05', 'VolumeTrader', 156.34, 112000.75, 63.80, -21.60, 5900, 5678, 5, '30D', 86.93, 'futures', '30d', NOW(), '{"roi":156.34}', '{"window_native":true}', 85.00, 3.68, 4.25),
  ('okx', 'OKX_7P8Q9R06', 'SmartLev', 123.89, 89000.50, 60.50, -24.30, 4500, 1234, 6, '30D', 84.17, 'futures', '30d', NOW(), '{"roi":123.89}', '{"window_native":true}', 85.00, 3.14, 4.03),
  ('okx', 'OKX_1S2T3U07', 'BasisTrader', 98.56, 67000.25, 85.20, -6.80, 3400, 6789, 7, '30D', 96.68, 'futures', '30d', NOW(), '{"roi":98.56}', '{"window_native":true}', 85.00, 6.64, 5.68),
  ('okx', 'OKX_4V5W6X08', 'LongTermBull', 76.23, 52000.00, 55.90, -28.40, 2600, 345, 8, '30D', 82.05, 'futures', '30d', NOW(), '{"roi":76.23}', '{"window_native":true}', 85.00, 2.32, 3.73),
  ('okx', 'OKX_7Y8Z9A09', 'ShortSeller', 54.89, 38000.75, 58.30, -26.90, 1900, 890, 9, '30D', 83.50, 'futures', '30d', NOW(), '{"roi":54.89}', '{"window_native":true}', 85.00, 2.62, 3.89),
  ('okx', 'OKX_1B2C3D10', 'HedgeFund', 42.34, 28000.50, 75.60, -9.10, 1400, 1567, 10, '30D', 94.22, 'futures', '30d', NOW(), '{"roi":42.34}', '{"window_native":true}', 85.00, 6.18, 5.04);

-- MEXC Futures snapshots (30d window, top 10)
INSERT INTO trader_snapshots (source, source_trader_id, nickname, roi, pnl, win_rate, max_drawdown, followers, trades_count, rank, season_id, arena_score, market_type, "window", as_of_ts, metrics, quality_flags, return_score, drawdown_score, stability_score)
VALUES
  ('mexc', 'MX_A1B2C301', 'MEXCWhale', 289.45, 198000.00, 67.80, -16.50, 8900, 2345, 1, '30D', 89.02, 'futures', '30d', NOW(), '{"roi":289.45}', '{"window_native":true}', 85.00, 4.70, 4.52),
  ('mexc', 'MX_D4E5F602', 'AltCoinPro', 234.12, 167000.50, 64.30, -19.20, 6700, 3456, 2, '30D', 87.45, 'futures', '30d', NOW(), '{"roi":234.12}', '{"window_native":true}', 85.00, 4.16, 4.29),
  ('mexc', 'MX_G7H8I903', 'MemeCoinHunter', 198.78, 134000.25, 52.10, -32.40, 5400, 4567, 3, '30D', 78.95, 'futures', '30d', NOW(), '{"roi":198.78}', '{"window_native":true}', 85.00, 1.52, 3.47),
  ('mexc', 'MX_J1K2L304', 'MEXCScalper', 156.34, 102000.00, 79.60, -7.80, 4200, 8901, 4, '30D', 95.75, 'futures', '30d', NOW(), '{"roi":156.34}', '{"window_native":true}', 85.00, 6.44, 5.31),
  ('mexc', 'MX_M4N5O605', 'LowCapGems', 123.67, 78000.75, 55.40, -28.60, 3100, 2345, 5, '30D', 81.97, 'futures', '30d', NOW(), '{"roi":123.67}', '{"window_native":true}', 85.00, 2.28, 3.69),
  ('mexc', 'MX_P7Q8R906', 'MEXCBot', 98.23, 56000.50, 86.30, -5.10, 2400, 12345, 6, '30D', 97.77, 'futures', '30d', NOW(), '{"roi":98.23}', '{"window_native":true}', 85.00, 6.98, 5.75),
  ('mexc', 'MX_S1T2U307', 'ShitcoinDegenerate', 78.56, 42000.25, 45.80, -38.90, 1800, 5678, 7, '30D', 75.23, 'futures', '30d', NOW(), '{"roi":78.56}', '{"window_native":true}', 85.00, 0.22, 3.05),
  ('mexc', 'MX_V4W5X608', 'SafeTrader', 56.89, 32000.00, 78.20, -8.30, 1400, 1234, 8, '30D', 95.55, 'futures', '30d', NOW(), '{"roi":56.89}', '{"window_native":true}', 85.00, 6.34, 5.21),
  ('mexc', 'MX_Y7Z8A909', 'NightShift', 34.12, 22000.75, 62.50, -20.70, 1050, 2345, 9, '30D', 87.03, 'futures', '30d', NOW(), '{"roi":34.12}', '{"window_native":true}', 85.00, 3.86, 4.17),
  ('mexc', 'MX_B1C2D310', 'MEXCNewbie', 18.45, 12000.50, 50.30, -34.20, 780, 890, 10, '30D', 77.49, 'futures', '30d', NOW(), '{"roi":18.45}', '{"window_native":true}', 85.00, 1.16, 3.35);

-- ==========================================
-- 3. TRADER PROFILES
-- ==========================================

-- Binance Futures profiles (top 10)
INSERT INTO trader_profiles (platform, market_type, trader_key, display_name, avatar_url, bio, tags, profile_url, followers, copiers, aum, provenance)
VALUES
  ('binance', 'futures', 'BN_3A9F2C01', 'CryptoAlpha', NULL, 'Professional crypto trader since 2019', ARRAY['top-10', 'high-roi'], 'https://www.binance.com/en/copy-trading/lead-details/BN_3A9F2C01', 15420, 2340, 1250000.00, '{"source_platform":"binance","acquisition_method":"api","scraper_version":"1.0.0"}'),
  ('binance', 'futures', 'BN_7B1E4D02', 'WhaleMaster', NULL, NULL, ARRAY['top-10'], 'https://www.binance.com/en/copy-trading/lead-details/BN_7B1E4D02', 12300, 1890, 980000.00, '{"source_platform":"binance","acquisition_method":"api","scraper_version":"1.0.0"}'),
  ('binance', 'futures', 'BN_5C2F8A03', 'DeltaTrader', NULL, 'Low drawdown specialist', ARRAY['low-drawdown'], 'https://www.binance.com/en/copy-trading/lead-details/BN_5C2F8A03', 9870, 1560, 750000.00, '{"source_platform":"binance","acquisition_method":"api","scraper_version":"1.0.0"}'),
  ('binance', 'futures', 'BN_2D4E6B04', 'AlphaQuant', NULL, 'Quantitative strategies only', ARRAY['quant'], 'https://www.binance.com/en/copy-trading/lead-details/BN_2D4E6B04', 8540, 1230, 620000.00, '{"source_platform":"binance","acquisition_method":"api","scraper_version":"1.0.0"}'),
  ('binance', 'futures', 'BN_9F1A3C05', 'BullRunner', NULL, NULL, ARRAY[]::text[], 'https://www.binance.com/en/copy-trading/lead-details/BN_9F1A3C05', 7650, 980, 450000.00, '{"source_platform":"binance","acquisition_method":"api","scraper_version":"1.0.0"}'),
  ('binance', 'futures', 'BN_4E7B2D06', 'MomentumKing', NULL, 'Momentum trading with strict risk management', ARRAY['momentum'], 'https://www.binance.com/en/copy-trading/lead-details/BN_4E7B2D06', 6230, 870, 380000.00, '{"source_platform":"binance","acquisition_method":"api","scraper_version":"1.0.0"}'),
  ('binance', 'futures', 'BN_8C3D5F07', 'ScalpMaster', NULL, 'High frequency scalping', ARRAY['scalper', 'high-winrate'], 'https://www.binance.com/en/copy-trading/lead-details/BN_8C3D5F07', 5420, 760, 290000.00, '{"source_platform":"binance","acquisition_method":"api","scraper_version":"1.0.0"}'),
  ('binance', 'futures', 'BN_1A6E9B08', 'TrendSurfer', NULL, NULL, ARRAY[]::text[], 'https://www.binance.com/en/copy-trading/lead-details/BN_1A6E9B08', 4890, 650, 220000.00, '{"source_platform":"binance","acquisition_method":"api","scraper_version":"1.0.0"}'),
  ('binance', 'futures', 'BN_6F2C4A09', 'GridBot99', NULL, 'Automated grid trading across pairs', ARRAY['bot', 'high-winrate'], 'https://www.binance.com/en/copy-trading/lead-details/BN_6F2C4A09', 4230, 540, 180000.00, '{"source_platform":"binance","acquisition_method":"api","scraper_version":"1.0.0"}'),
  ('binance', 'futures', 'BN_3B8D7E10', 'SwingPro', NULL, NULL, ARRAY['swing'], 'https://www.binance.com/en/copy-trading/lead-details/BN_3B8D7E10', 3870, 430, 150000.00, '{"source_platform":"binance","acquisition_method":"api","scraper_version":"1.0.0"}');

-- Bybit profiles (top 5)
INSERT INTO trader_profiles (platform, market_type, trader_key, display_name, profile_url, followers, copiers, provenance)
VALUES
  ('bybit', 'futures', 'BY_A1B2C301', 'BybitWhale', 'https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=BY_A1B2C301', 18900, 3200, '{"source_platform":"bybit","acquisition_method":"api","scraper_version":"1.0.0"}'),
  ('bybit', 'futures', 'BY_D4E5F602', 'SniperEntry', 'https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=BY_D4E5F602', 14200, 2400, '{"source_platform":"bybit","acquisition_method":"api","scraper_version":"1.0.0"}'),
  ('bybit', 'futures', 'BY_G7H8I903', 'MartingaleBot', 'https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=BY_G7H8I903', 11800, 1900, '{"source_platform":"bybit","acquisition_method":"api","scraper_version":"1.0.0"}'),
  ('bybit', 'futures', 'BY_J1K2L304', 'TrendFollower', 'https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=BY_J1K2L304', 9500, 1500, '{"source_platform":"bybit","acquisition_method":"api","scraper_version":"1.0.0"}'),
  ('bybit', 'futures', 'BY_M4N5O605', 'GridMaster', 'https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=BY_M4N5O605', 7800, 1200, '{"source_platform":"bybit","acquisition_method":"api","scraper_version":"1.0.0"}');

-- ==========================================
-- 4. REFRESH JOBS (demonstration entries)
-- ==========================================
INSERT INTO refresh_jobs (job_type, platform, market_type, trader_key, "window", priority, status, attempts, max_attempts, next_run_at)
VALUES
  ('discover', 'binance', 'futures', NULL, '30d', 10, 'pending', 0, 3, NOW()),
  ('discover', 'bybit', 'futures', NULL, '30d', 10, 'pending', 0, 3, NOW()),
  ('discover', 'bitget', 'futures', NULL, '30d', 10, 'pending', 0, 3, NOW()),
  ('snapshot', 'binance', 'futures', 'BN_3A9F2C01', '30d', 20, 'pending', 0, 3, NOW()),
  ('snapshot', 'binance', 'futures', 'BN_7B1E4D02', '30d', 20, 'pending', 0, 3, NOW()),
  ('profile', 'binance', 'futures', 'BN_3A9F2C01', NULL, 30, 'pending', 0, 3, NOW()),
  ('profile', 'binance', 'futures', 'BN_5C2F8A03', NULL, 30, 'pending', 0, 3, NOW());

COMMIT;
