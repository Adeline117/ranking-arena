-- Migration: Trader Activities Feed
-- Date: 2026-02-23
-- Purpose: Auto-generated activity events from trader data changes.
--          Powers the public /feed page and per-trader timeline.

-- ============================================================
-- 1. trader_activities table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.trader_activities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Trader identity (denormalized for O(1) reads)
  source         TEXT NOT NULL,          -- exchange source (binance, bybit, etc.)
  source_trader_id TEXT NOT NULL,        -- raw trader ID on that exchange
  handle         TEXT,                   -- display name / handle
  avatar_url     TEXT,                   -- avatar for feed rendering

  -- Activity classification
  activity_type  TEXT NOT NULL,          -- rank_up | roi_milestone | score_high | win_streak | large_profit | entered_top10 | large_trade
  activity_text  TEXT NOT NULL,          -- human-readable sentence

  -- Numeric payload (optional, for OG card rendering / sorting)
  metric_value   NUMERIC,               -- e.g. roi=200, rank=12, streak=5
  metric_label   TEXT,                  -- e.g. "ROI", "Rank", "Streak"

  -- Deduplication key: prevent duplicate events for the same change
  dedup_key      TEXT NOT NULL,

  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 2. Dedup constraint
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_trader_activities_dedup
  ON public.trader_activities (dedup_key);

-- ============================================================
-- 3. Read indexes
-- ============================================================

-- Primary feed: latest-first, optional source filter
CREATE INDEX IF NOT EXISTS idx_trader_activities_feed
  ON public.trader_activities (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_trader_activities_source
  ON public.trader_activities (source, occurred_at DESC);

-- Per-trader timeline
CREATE INDEX IF NOT EXISTS idx_trader_activities_trader
  ON public.trader_activities (source, source_trader_id, occurred_at DESC);

-- Handle-based lookup (for sharing links)
CREATE INDEX IF NOT EXISTS idx_trader_activities_handle
  ON public.trader_activities (handle, occurred_at DESC)
  WHERE handle IS NOT NULL;

-- ============================================================
-- 4. RLS (public read, no direct writes from client)
-- ============================================================
ALTER TABLE public.trader_activities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read trader activities"
  ON public.trader_activities FOR SELECT
  USING (true);

-- Service role key bypasses RLS for writes from cron jobs
