-- Migration: Add avatar_url column to trader_sources
-- Date: 2025-07-18
-- Purpose: Separate avatar image URLs from profile page URLs
--
-- Background:
--   Many import scripts were storing avatar image URLs in the profile_url column,
--   while others stored profile page URLs there. This migration adds a dedicated
--   avatar_url column and migrates existing image URLs from profile_url.

-- 1. Add the avatar_url column
ALTER TABLE trader_sources ADD COLUMN IF NOT EXISTS avatar_url text;

-- 2. Migrate existing profile_url values that are actually image URLs
--    (from platforms that stored avatar URLs in profile_url)
UPDATE trader_sources
SET avatar_url = profile_url
WHERE profile_url IS NOT NULL
  AND avatar_url IS NULL
  AND (
    -- Known image CDN domains
    profile_url LIKE '%bnbstatic.com%'
    OR profile_url LIKE '%tylhh.net%'
    OR profile_url LIKE '%nftstatic.com%'
    OR profile_url LIKE '%myqcloud.com%'
    OR profile_url LIKE '%bscdnweb.com%'
    OR profile_url LIKE '%coinexstatic.com%'
    OR profile_url LIKE '%mocortech.com%'
    OR profile_url LIKE '%staticimg.com%'
    OR profile_url LIKE '%bycsi.com%'
    OR profile_url LIKE '%lbkrs.com%'
    OR profile_url LIKE '%wexx.one%'
    OR profile_url LIKE '%bgstatic.com%'
    -- Image file extensions
    OR profile_url LIKE '%.jpg'
    OR profile_url LIKE '%.jpeg'
    OR profile_url LIKE '%.png'
    OR profile_url LIKE '%.webp'
    OR profile_url LIKE '%.gif'
    OR profile_url LIKE '%.svg'
    -- Known image path patterns
    OR profile_url LIKE '%/image/avatar/%'
    OR profile_url LIKE '%/avatar/%'
    OR profile_url LIKE '%/static/nft/%'
  );

-- 3. Clear profile_url for rows where it was actually an image URL (not a profile page)
--    Keep profile_url only for actual profile page URLs
UPDATE trader_sources
SET profile_url = NULL
WHERE profile_url IS NOT NULL
  AND avatar_url = profile_url
  AND source IN (
    'binance_futures',
    'bybit',
    'coinex',
    'kucoin',
    'weex',
    'lbank',
    'blofin',
    'xt',
    'mexc'
  );

-- 4. Create index for avatar_url lookups
CREATE INDEX IF NOT EXISTS idx_trader_sources_avatar_url ON trader_sources (avatar_url) WHERE avatar_url IS NOT NULL;
