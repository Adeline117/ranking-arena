-- Migration: 20260416162636_backfill_trader_sources_from_leaderboard_ranks.sql
-- Created: 2026-04-16
-- Description: Backfill missing trader_sources rows so leaderboard clicks resolve
--
-- Root cause: compute-leaderboard reads from trader_snapshots_v2 (ranks traders
-- and looks up handles in trader_profiles_v2) but never enforces a matching
-- trader_sources row. Users clicking top-ranked rows from orphan traders hit
-- a broken profile page (no source record).
--
-- Audit (2026-04-16):
--   17,876 leaderboard_ranks rows (arena_score>0, !is_outlier) have NO
--   matching trader_sources row.
--   92 of these orphan rows appear in the top-100 of some season — directly
--   user-visible.
--   Biggest offenders: mexc (5489), etoro (3124), hyperliquid (2797),
--   binance_futures (2352), binance_web3 (1904).
--
-- Fix: INSERT ... ON CONFLICT DO NOTHING to add the missing trader_sources
-- rows using (source, source_trader_id, handle, avatar_url) from the most
-- recent leaderboard_ranks entry per trader. `is_active=true` + created_at=now()
-- so the normal refresh pipeline will enrich these going forward.

INSERT INTO public.trader_sources (
  source,
  source_trader_id,
  handle,
  avatar_url,
  is_active,
  identity_type,
  source_kind,
  source_type,
  created_at,
  last_seen_at
)
SELECT
  lr.source,
  lr.source_trader_id,
  MAX(lr.handle) AS handle,
  MAX(lr.avatar_url) AS avatar_url,
  true AS is_active,
  'public' AS identity_type,
  CASE
    WHEN lr.source IN ('hyperliquid', 'gmx', 'dydx', 'vertex', 'drift', 'aevo',
                       'gains', 'kwenta', 'jupiter_perps', 'binance_web3',
                       'okx_web3', 'bybit_web3', 'polymarket')
      THEN 'dex_leaderboard'
    ELSE 'cex_leaderboard'
  END AS source_kind,
  MAX(lr.source_type) AS source_type,
  NOW() AS created_at,
  NOW() AS last_seen_at
FROM public.leaderboard_ranks lr
WHERE NOT EXISTS (
  SELECT 1 FROM public.trader_sources tsrc
  WHERE tsrc.source = lr.source
    AND tsrc.source_trader_id = lr.source_trader_id
)
GROUP BY lr.source, lr.source_trader_id
ON CONFLICT (source, source_trader_id) DO NOTHING;
