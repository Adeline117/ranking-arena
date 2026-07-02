-- Migration: 20260702120132_apply_onchain_enrichment.sql
-- On-demand on-chain enrichment write path (Phase A — 即看即算).
--
-- The web3 profile page triggers a bounded on-chain recompute via an API route
-- when a wallet has no onchain_* data yet; the route calls this RPC to persist
-- the result. Mirrors the worker processor's write: MERGE onchain_* keys into
-- trader_stats.extras (never clobbering board values) + fill win_rate only when
-- the board left it NULL. SECURITY DEFINER so the service role can write arena.*
-- without exposing the table via PostgREST.

-- Up
CREATE OR REPLACE FUNCTION public.arena_apply_onchain_enrichment(
  p_source text,
  p_exchange_trader_id text,
  p_extras jsonb,
  p_win_rate numeric DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = arena, public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE arena.trader_stats ts SET
    extras = ts.extras || p_extras,
    win_rate = COALESCE(ts.win_rate, p_win_rate)
  FROM arena.traders t, arena.sources s
  WHERE ts.trader_id = t.id
    AND t.source_id = s.id
    AND s.slug = p_source
    AND t.exchange_trader_id = p_exchange_trader_id
    AND ts.timeframe = 90;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.arena_apply_onchain_enrichment(text, text, jsonb, numeric) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_apply_onchain_enrichment(text, text, jsonb, numeric) TO service_role;
