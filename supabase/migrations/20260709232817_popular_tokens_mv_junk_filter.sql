-- Migration: 20260709232817_popular_tokens_mv_junk_filter.sql
-- Created: 2026-07-09T23:28:17Z
-- Description: mv_popular_tokens_90d 源头过滤垃圾符号(U1-5 根治)+ LIMIT 提到 60

-- 背景:/rankings/tokens 榜垃圾符号(HL-107 = #4 178k 笔、XYZ:CL/XYZ:TSLA/XYZ:SP500 等
-- 股票/商品 CFD 占 top-25 的 ~56%)。MV 只有 LIMIT 50 行,过半是垃圾 → RPC/API 消费者
-- (by-token popular-tokens + tokens 页切到 RPC 后)最多只能显 ~26 个干净 token。
-- 前端 isValidTokenSymbol 后过滤治标不治本(MV 根本没纳入干净 token)。根治:在 MV 的
-- WHERE 加与 isValidTokenSymbol 等价的过滤(纯字母数字≤10 且含至少一字母),LIMIT 提到 60
-- 给消费者切 50 的余量。BTC 未被拆(现有斜杠提取正确),只加垃圾过滤。
-- CONCURRENTLY 刷新依赖 token 唯一索引,重建时保留。

-- Up:两个函数依赖 MV,显式先删函数再删 MV,重建全部(等价定义 + 过滤)。
DROP FUNCTION IF EXISTS public.get_popular_tokens(integer, integer);
DROP FUNCTION IF EXISTS public.refresh_popular_tokens_mv();
DROP MATERIALIZED VIEW IF EXISTS public.mv_popular_tokens_90d;

CREATE MATERIALIZED VIEW public.mv_popular_tokens_90d AS
WITH base_tokens AS (
  SELECT upper(
      CASE
        WHEN symbol::text ~~* '%.P'::text THEN regexp_replace(symbol::text, '(?i)usdt\.p$'::text, ''::text)
        WHEN symbol::text ~~* '%USDT'::text THEN regexp_replace(symbol::text, '(?i)usdt$'::text, ''::text)
        WHEN symbol::text ~~* '%BUSD'::text THEN regexp_replace(symbol::text, '(?i)busd$'::text, ''::text)
        WHEN symbol::text ~~* '%-PERP'::text THEN regexp_replace(symbol::text, '(?i)-perp$'::text, ''::text)
        WHEN symbol::text ~~* '%-USD'::text THEN regexp_replace(symbol::text, '(?i)-usd$'::text, ''::text)
        WHEN symbol::text ~~* '%USD'::text THEN regexp_replace(symbol::text, '(?i)usd$'::text, ''::text)
        WHEN symbol::text ~~ '%/%'::text THEN split_part(symbol::text, '/'::text, 1)
        ELSE symbol::text
      END) AS base_token,
    source, source_trader_id, pnl_usd
  FROM public.trader_position_history
  WHERE close_time >= (now() - '90 days'::interval) AND pnl_usd IS NOT NULL
)
SELECT base_token AS token,
    count(*) AS trade_count,
    count(DISTINCT (source::text || ':'::text) || source_trader_id::text) AS trader_count,
    round(sum(pnl_usd), 2) AS total_pnl
FROM base_tokens bt
WHERE length(base_token) <= 10
  AND base_token <> ''::text
  -- U1-5 junk filter (等价 lib/utils/token-symbol.ts isValidTokenSymbol):
  -- 纯大写字母数字 + 至少一个字母。滤掉 HL-107(横杠)、XYZ:TSLA(冒号,股票 CFD)、
  -- 纯数字 id 等——它们从 top-N 消失,让位给真加密 token。
  AND base_token ~ '^[A-Z0-9]+$'
  AND base_token ~ '[A-Z]'
GROUP BY base_token
ORDER BY count(*) DESC
LIMIT 60;

CREATE UNIQUE INDEX idx_mv_popular_tokens_token ON public.mv_popular_tokens_90d USING btree (token);

CREATE FUNCTION public.get_popular_tokens(lookback_days integer DEFAULT 90, max_tokens integer DEFAULT 50)
RETURNS TABLE(token text, trade_count bigint, trader_count bigint, total_pnl numeric)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $function$
  SELECT token, trade_count, trader_count, total_pnl
  FROM mv_popular_tokens_90d
  ORDER BY trade_count DESC
  LIMIT max_tokens;
$function$;

CREATE FUNCTION public.refresh_popular_tokens_mv()
RETURNS void LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF (SELECT ispopulated FROM pg_matviews WHERE matviewname = 'mv_popular_tokens_90d') THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_popular_tokens_90d;
  ELSE
    REFRESH MATERIALIZED VIEW mv_popular_tokens_90d;
  END IF;
END;
$function$;

GRANT SELECT ON public.mv_popular_tokens_90d TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_popular_tokens(integer, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_popular_tokens_mv() TO service_role;
