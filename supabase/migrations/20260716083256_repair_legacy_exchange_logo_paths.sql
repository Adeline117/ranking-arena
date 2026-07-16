-- Migration: 20260716083256_repair_legacy_exchange_logo_paths.sql
-- Created: 2026-07-16T08:32:56Z
-- Description: Replace persisted fallback-logo paths that no longer exist in
-- public/icons/exchanges. Only exact historical values are changed; exchange
-- CDN avatars and future non-PNG assets are left untouched.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

SELECT pg_advisory_xact_lock(hashtextextended('repair_legacy_exchange_logo_paths', 0));

-- Match the production writer's lock order and update the partitioned parent
-- only. Do not touch computed_at: an asset-path repair is not fresh market data.
LOCK TABLE public.trader_sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE legacy_exchange_logo_path_map (
  old_path text PRIMARY KEY,
  new_path text NOT NULL
) ON COMMIT DROP;

INSERT INTO legacy_exchange_logo_path_map (old_path, new_path)
VALUES
  ('/icons/exchanges/binance.jpg', '/icons/exchanges/binance.png'),
  ('/icons/exchanges/coinex.jpg', '/icons/exchanges/coinex.png'),
  ('/icons/exchanges/copin.svg', '/icons/exchanges/copin.png'),
  ('/icons/exchanges/etoro.svg', '/icons/exchanges/etoro.png'),
  ('/icons/exchanges/gains.svg', '/icons/exchanges/gains.png'),
  ('/icons/exchanges/gateio.png', '/icons/exchanges/gate.png'),
  ('/icons/exchanges/gmx.svg', '/icons/exchanges/gmx.png'),
  ('/icons/exchanges/mexc.jpeg', '/icons/exchanges/mexc.png'),
  ('/icons/exchanges/okx.svg', '/icons/exchanges/okx.png'),
  ('/icons/exchanges/polymarket.svg', '/icons/exchanges/polymarket.png'),
  ('/icons/exchanges/woox.svg', '/icons/exchanges/woox.png');

UPDATE public.trader_sources AS trader
SET avatar_url = logo.new_path
FROM legacy_exchange_logo_path_map AS logo
WHERE trader.avatar_url = logo.old_path;

UPDATE public.leaderboard_ranks AS rank
SET avatar_url = logo.new_path
FROM legacy_exchange_logo_path_map AS logo
WHERE rank.avatar_url = logo.old_path;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.trader_sources AS trader
    JOIN legacy_exchange_logo_path_map AS logo ON logo.old_path = trader.avatar_url
  ) OR EXISTS (
    SELECT 1
    FROM public.leaderboard_ranks AS rank
    JOIN legacy_exchange_logo_path_map AS logo ON logo.old_path = rank.avatar_url
  ) THEN
    RAISE EXCEPTION 'legacy exchange logo paths remain after repair';
  END IF;
END;
$$;

COMMIT;

-- Rollback: no data rollback is provided because the old paths are missing
-- assets and restoring them would recreate production 404s. The application
-- accepts the canonical PNG paths before and after this migration.
