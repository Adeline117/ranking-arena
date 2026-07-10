-- Migration: 20260710103004_arena_trust_scorecard_rpc.sql
-- Created: 2026-07-10T17:30:04Z
-- Description: 可信度记分卡(P6) — arena.trust_scorecard_daily 快照表 +
--   arena_trust_scorecard() 聚合 RPC,admin 面板 5 秒看清六维进度。
--
-- 为什么要快照表:序列覆盖(serving×trader_series EXISTS)实测 14s
-- (12k serving × 12 个月度分区 Append),不能进面板 RPC。照
-- metric_fill_trend 同款模式:重查询由夜间脚本
-- (scripts/qa/trust-scorecard-snapshot.mjs, crontab)算好落表,
-- RPC 只读最近快照 + 实时便宜维度(链上富化/认领/社区 bot 帖)。

-- Up
CREATE TABLE IF NOT EXISTS arena.trust_scorecard_daily (
  taken_on date PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE arena.trust_scorecard_daily ENABLE ROW LEVEL SECURITY;
-- service_role bypasses RLS; no policies = nobody else reads.

CREATE OR REPLACE FUNCTION public.arena_trust_scorecard()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = arena, public
AS $$
SELECT jsonb_build_object(
  -- ① 序列覆盖:最近 14 天快照(面板画趋势/日增)
  'series', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'taken_on', d.taken_on, 'payload', d.payload
    ) ORDER BY d.taken_on DESC)
    FROM (
      SELECT taken_on, payload FROM arena.trust_scorecard_daily
      ORDER BY taken_on DESC LIMIT 14
    ) d
  ), '[]'::jsonb),
  -- ⑥ 链上富化净覆盖(serving 集合内,轮换侵蚀直接可见)。
  -- 接地陷阱:BSC 在 serving 里的 lr.source = 'binance_web3'(legacy 名),
  -- arena slug 是 binance_web3_bsc — 必须经 meta->>'legacy_platform' 映射。
  'onchain', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'slug', o.slug, 'serving', o.serving, 'enriched', o.enriched,
      'fresh7d', o.fresh7d
    ) ORDER BY o.slug)
    FROM (
      SELECT s.slug,
             count(*) AS serving,
             count(*) FILTER (WHERE ts.extras ? 'onchain_enriched_at') AS enriched,
             count(*) FILTER (
               WHERE (ts.extras->>'onchain_enriched_at')::timestamptz
                     > now() - interval '7 days') AS fresh7d
        FROM (SELECT DISTINCT lr.source, lr.source_trader_id
                FROM public.leaderboard_ranks lr
               WHERE lr.source IN ('okx_web3_solana','binance_web3','binance_web3_bsc')) sv
        JOIN arena.sources s
          ON s.slug = sv.source OR s.meta->>'legacy_platform' = sv.source
        JOIN arena.traders t ON t.source_id = s.id
                            AND t.exchange_trader_id = sv.source_trader_id
        LEFT JOIN arena.trader_stats ts ON ts.trader_id = t.id AND ts.timeframe = 90
       WHERE s.slug IN ('okx_web3_solana','binance_web3_bsc')
       GROUP BY s.slug
    ) o
  ), '[]'::jsonb),
  -- ④ 认领升维
  'claims', jsonb_build_object(
    'total', (SELECT count(*) FROM public.trader_claims),
    'verified', (SELECT count(*) FROM public.trader_claims WHERE verified_at IS NOT NULL),
    'reviewing', (SELECT count(*) FROM public.trader_claims WHERE status = 'reviewing'),
    'active_authorizations',
      (SELECT count(*) FROM public.trader_authorizations WHERE status = 'active')
  ),
  -- ⑤ 社区可信面(bot 帖节律)
  'community', jsonb_build_object(
    'last_bot_post_at', (SELECT max(created_at) FROM public.posts
                          WHERE author_id = '00000000-0000-0000-0000-000000000001'),
    'bot_posts_7d', (SELECT count(*) FROM public.posts
                      WHERE author_id = '00000000-0000-0000-0000-000000000001'
                        AND created_at > now() - interval '7 days')
  )
);
$$;
REVOKE EXECUTE ON FUNCTION public.arena_trust_scorecard() FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.arena_trust_scorecard() TO service_role;
