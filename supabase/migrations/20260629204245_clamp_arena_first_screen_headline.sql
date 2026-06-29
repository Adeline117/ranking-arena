-- Migration: 20260629204245_clamp_arena_first_screen_headline.sql
-- Created: 2026-06-29T20:42:45Z (ledger version 20260629204245)
-- Description: Clamp headline_roi / headline_win_rate in arena_first_screen.
--
-- Companion to the arena_core_modules clamp. arena_first_screen renders the very
-- first screen of every trader profile from arena.leaderboard_entries (the board
-- headline), unclamped. The data-read audit found the kucoin ROI parser bug
-- (roi vs ~0 principal) lands in headline_roi too: e.g. 230,268,719,347% with a
-- $26 PnL. compute-leaderboard clamps when building lr_* (leaderboards are clean)
-- but first-screen reads the raw entry, so the headline showed the garbage.
--
-- Apply the same canonical bounds: roi clamped to [-10000,10000], win_rate NULLed
-- outside [0,100]. Display-only; raw entries untouched. Root-cause kucoin ROI
-- parser fix tracked separately.

-- Up
CREATE OR REPLACE FUNCTION public.arena_first_screen(p_source text, p_trader text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'arena', 'public'
AS $function$
  SELECT jsonb_build_object(
    'source', s.slug,
    'exchangeTraderId', t.exchange_trader_id,
    'nickname', t.nickname,
    'avatarMirrorUrl', t.avatar_url_mirror,
    'avatarOriginUrl', t.avatar_url_origin,
    'walletAddress', t.wallet_address,
    'traderKind', t.trader_kind,
    'botStrategy', t.bot_strategy,
    'currency', s.currency,
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'timeframe', e.timeframe,
               'rank', e.rank,
               'headlineRoi', LEAST(10000, GREATEST(-10000, e.headline_roi)),
               'headlinePnl', e.headline_pnl,
               'headlineWinRate',
                 CASE WHEN e.headline_win_rate >= 0 AND e.headline_win_rate <= 100
                      THEN e.headline_win_rate END,
               'currency', e.currency,
               'extras', COALESCE(e.raw, '{}'::jsonb),
               'asOf', e.scraped_at
             ) ORDER BY e.timeframe)
        FROM (
          SELECT DISTINCT ON (e.timeframe) e.*
            FROM arena.leaderboard_entries e
            JOIN arena.leaderboard_snapshots ls ON ls.id = e.snapshot_id
           WHERE e.trader_id = t.id AND ls.count_check_passed
           ORDER BY e.timeframe, e.scraped_at DESC
        ) e
    ), '[]'::jsonb)
  )
    FROM arena.traders t
    JOIN arena.sources s ON s.id = t.source_id
   WHERE s.slug = p_source AND t.exchange_trader_id = p_trader;
$function$;
