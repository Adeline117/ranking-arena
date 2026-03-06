-- Expand flash_news category CHECK constraint to include new categories
-- The cron job (flash-news-fetch) uses btc_eth, altcoin, exchange but the
-- original constraint only allowed crypto, macro, defi, regulation, market.

ALTER TABLE flash_news DROP CONSTRAINT IF EXISTS flash_news_category_check;
ALTER TABLE flash_news ADD CONSTRAINT flash_news_category_check
  CHECK (category IN ('crypto', 'macro', 'defi', 'regulation', 'market', 'btc_eth', 'altcoin', 'exchange'));
