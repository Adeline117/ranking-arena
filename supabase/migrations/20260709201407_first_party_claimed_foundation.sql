-- Migration: 20260709201407_first_party_claimed_foundation.sql
-- Created: 2026-07-09T20:14:07Z (PT)
-- Description: 认领交易员 P1 地基 — 第一方权益快照表 + claimed 标记 RPC + 授权同步列
--
-- 认领交易员大特性(owner 拍板 2026-07-09):绑定只读 API 的交易员停止被抓,
-- 全部 stats 从他自己账号计算(first-party)。本迁移只落数据模型;worker 引擎
-- 与 score_inputs view 双分支在后续迁移/代码接线。

-- Up

-- ── 1. 第一方权益快照(权益曲线/ROI 分母/MDD 的事实源) ──
CREATE TABLE IF NOT EXISTS arena.first_party_snapshots (
  trader_id        bigint      NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  ts               timestamptz NOT NULL,
  equity           numeric     NOT NULL,
  balance          numeric,
  unrealized_pnl   numeric,
  net_transfer_cum numeric,
  currency         text        NOT NULL DEFAULT 'USDT',
  PRIMARY KEY (trader_id, ts)
);
-- arena 模式:不经 PostgREST 直读,worker service_role 专用
ALTER TABLE arena.first_party_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON arena.first_party_snapshots FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON arena.first_party_snapshots TO service_role;

-- ── 2. claimed 标记 RPC(admin 批准激活链调用) ──
-- slug 或 legacy_platform 解析源;交易员不存在则 upsert(多账号的小号可能从未上榜)。
CREATE OR REPLACE FUNCTION public.arena_set_trader_claimed(
  p_platform text,
  p_trader_key text,
  p_user_id uuid,
  p_claimed boolean
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = arena, public
AS $$
DECLARE
  v_source_id smallint;
  v_trader_id bigint;
BEGIN
  SELECT id INTO v_source_id FROM arena.sources
   WHERE slug = p_platform OR meta->>'legacy_platform' = p_platform
   LIMIT 1;
  IF v_source_id IS NULL THEN
    RAISE EXCEPTION 'unknown platform %', p_platform;
  END IF;

  INSERT INTO arena.traders (source_id, exchange_trader_id, meta)
  VALUES (v_source_id, p_trader_key, '{}'::jsonb)
  ON CONFLICT (source_id, exchange_trader_id) DO NOTHING;

  UPDATE arena.traders
     SET meta = COALESCE(meta, '{}'::jsonb)
             || CASE WHEN p_claimed
                THEN jsonb_build_object(
                       'claimed', true,
                       'claimed_at', now(),
                       'claimed_by_user_id', p_user_id::text)
                ELSE jsonb_build_object('claimed', false) END
   WHERE source_id = v_source_id AND exchange_trader_id = p_trader_key
   RETURNING id INTO v_trader_id;
  RETURN v_trader_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.arena_set_trader_claimed(text, text, uuid, boolean) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.arena_set_trader_claimed(text, text, uuid, boolean) TO service_role;

-- ── 3. 授权同步观测列 + 绑定时只读 scope 存证 ──
ALTER TABLE public.trader_authorizations
  ADD COLUMN IF NOT EXISTS last_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sync_status text,
  ADD COLUMN IF NOT EXISTS consecutive_failures int NOT NULL DEFAULT 0;

ALTER TABLE public.user_exchange_connections
  ADD COLUMN IF NOT EXISTS scope_permissions jsonb;
