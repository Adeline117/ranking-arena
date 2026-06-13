-- Bot profile header (spec §1.3): a bot's profile is a traders row
-- (trader_kind='bot') whose id = bots.shadow_trader_id. This RPC returns the
-- bot-specific metadata to render the header card (bot id, pair, strategy,
-- direction, runtime, profit-share %, and a link to the owner "交易机器人专家").
-- Keyed by (source, exchange_trader_id) — the same identity the frontend
-- already has — so no internal trader id leaks to the client. Returns NULL for
-- non-bot traders. Public grant, same as the other serving RPCs (bot metadata
-- is public profile data, not PII).
CREATE OR REPLACE FUNCTION public.arena_bot_header(p_source text, p_trader_key text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = arena, public
AS $$
  SELECT to_jsonb(r) FROM (
    SELECT
      b.exchange_bot_id        AS bot_id,
      b.pair,
      b.product_type,
      b.bot_strategy,
      b.direction,
      b.runtime_days,
      b.profit_share_rate,
      b.created_at_origin,
      b.status,
      ot.nickname              AS owner_nickname,
      ot.exchange_trader_id    AS owner_trader_key,
      COALESCE(os.meta->>'legacy_platform', os.slug) AS owner_platform
    FROM arena.bots b
    JOIN arena.traders t  ON t.id = b.shadow_trader_id
    JOIN arena.sources s  ON s.id = t.source_id
    LEFT JOIN arena.traders ot ON ot.id = b.owner_trader_id
    LEFT JOIN arena.sources os ON os.id = ot.source_id
    WHERE t.exchange_trader_id = p_trader_key
      AND COALESCE(s.meta->>'legacy_platform', s.slug) = p_source
    LIMIT 1
  ) r;
$$;

REVOKE ALL ON FUNCTION public.arena_bot_header(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.arena_bot_header(text, text) TO anon, authenticated, service_role;
