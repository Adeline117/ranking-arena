-- Add sort_priority to institutions and tools for meaningful Top 10 ordering
-- When avg_rating is 0 for all items, sort_priority determines leaderboard rank

ALTER TABLE institutions ADD COLUMN IF NOT EXISTS sort_priority INTEGER;

-- Exchanges
UPDATE institutions SET sort_priority = 1 WHERE name ILIKE '%binance%' AND category IN ('cex', 'exchange');
UPDATE institutions SET sort_priority = 2 WHERE name ILIKE '%coinbase%' AND category IN ('cex', 'exchange');
UPDATE institutions SET sort_priority = 3 WHERE name ILIKE '%okx%' AND category IN ('cex', 'exchange');
UPDATE institutions SET sort_priority = 4 WHERE name ILIKE '%bybit%' AND category IN ('cex', 'exchange');
UPDATE institutions SET sort_priority = 5 WHERE name ILIKE '%kraken%' AND category IN ('cex', 'exchange');

-- Funds
UPDATE institutions SET sort_priority = 1 WHERE name ILIKE '%a16z%' AND category IN ('fund', 'crypto-vc');
UPDATE institutions SET sort_priority = 2 WHERE name ILIKE '%paradigm%' AND category IN ('fund', 'crypto-vc');
UPDATE institutions SET sort_priority = 3 WHERE name ILIKE '%sequoia%' AND category IN ('fund', 'crypto-vc', 'traditional-vc');
UPDATE institutions SET sort_priority = 4 WHERE name ILIKE '%pantera%' AND category IN ('fund', 'crypto-vc');

-- Projects
UPDATE institutions SET sort_priority = 1 WHERE name ILIKE '%ethereum%' AND category IN ('l1', 'project');
UPDATE institutions SET sort_priority = 2 WHERE name ILIKE '%solana%' AND category IN ('l1', 'project');
UPDATE institutions SET sort_priority = 3 WHERE name ILIKE '%bitcoin%' AND category IN ('l1', 'project');

-- Tools
ALTER TABLE tools ADD COLUMN IF NOT EXISTS sort_priority INTEGER;
UPDATE tools SET sort_priority = 1 WHERE name ILIKE '%tradingview%';
UPDATE tools SET sort_priority = 2 WHERE name ILIKE '%coinglass%';
UPDATE tools SET sort_priority = 3 WHERE name ILIKE '%dexscreener%';
