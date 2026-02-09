-- Fix migration: Create trader_alerts table (missing base table for 00073)
-- and fix 00074 indexes (window is a reserved word)

-- 1. Create trader_alerts base table
CREATE TABLE IF NOT EXISTS trader_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  source TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  alert_roi_change BOOLEAN DEFAULT TRUE,
  roi_change_threshold NUMERIC DEFAULT 10,
  alert_drawdown BOOLEAN DEFAULT TRUE,
  drawdown_threshold NUMERIC DEFAULT 20,
  alert_pnl_change BOOLEAN DEFAULT FALSE,
  pnl_change_threshold NUMERIC DEFAULT 5000,
  alert_score_change BOOLEAN DEFAULT TRUE,
  score_change_threshold NUMERIC DEFAULT 5,
  alert_rank_change BOOLEAN DEFAULT FALSE,
  rank_change_threshold INTEGER DEFAULT 5,
  alert_new_position BOOLEAN DEFAULT FALSE,
  alert_price_above BOOLEAN DEFAULT FALSE,
  price_above_value NUMERIC DEFAULT NULL,
  alert_price_below BOOLEAN DEFAULT FALSE,
  price_below_value NUMERIC DEFAULT NULL,
  price_symbol VARCHAR(20) DEFAULT NULL,
  last_triggered_at TIMESTAMPTZ DEFAULT NULL,
  one_time BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, trader_id)
);

CREATE INDEX IF NOT EXISTS idx_trader_alerts_user ON trader_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_trader_alerts_trader ON trader_alerts(trader_id);

ALTER TABLE trader_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own alerts" ON trader_alerts
  FOR ALL USING (auth.uid() = user_id);

-- 2. Create alert_history table (from 00073)
CREATE TABLE IF NOT EXISTS alert_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id UUID NOT NULL REFERENCES trader_alerts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  alert_type VARCHAR(30) NOT NULL,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_alert_history_alert_id ON alert_history(alert_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_history_user_id ON alert_history(user_id, triggered_at DESC);

ALTER TABLE alert_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own alert history"
  ON alert_history FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "System can insert alert history"
  ON alert_history FOR INSERT
  WITH CHECK (TRUE);

-- 3. Fix 00074 indexes (quote "window" as it's a reserved word)
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_season_arena
  ON trader_snapshots(season_id, arena_score DESC NULLS LAST)
  WHERE arena_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trader_snapshots_v2_ranking
  ON trader_snapshots(source, market_type, "window", arena_score DESC NULLS LAST)
  WHERE arena_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trader_snapshots_v2_roi
  ON trader_snapshots(source, market_type, "window", roi DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_trader_snapshots_v2_pnl
  ON trader_snapshots(source, market_type, "window", pnl DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_trader_snapshots_top_traders
  ON trader_snapshots(season_id, arena_score DESC NULLS LAST)
  WHERE arena_score IS NOT NULL AND arena_score > 0;

CREATE INDEX IF NOT EXISTS idx_trader_snapshots_trader_lookup
  ON trader_snapshots(source, source_trader_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_trader_sources_source_trader
  ON trader_sources(source, source_trader_id);

CREATE INDEX IF NOT EXISTS idx_trader_sources_missing_avatar
  ON trader_sources(source)
  WHERE avatar_url IS NULL;

CREATE INDEX IF NOT EXISTS idx_trader_sources_active_source_trader
  ON trader_sources(source, source_trader_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_posts_like_count_desc
  ON posts(like_count DESC NULLS LAST, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_flash_news_category_published
  ON flash_news(category, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_flash_news_importance_published
  ON flash_news(importance DESC, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_library_items_category_created
  ON library_items(category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_library_items_view_count
  ON library_items(view_count DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_season_source
  ON leaderboard_ranks(season_id, source, rank ASC);
