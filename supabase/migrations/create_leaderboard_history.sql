-- Create leaderboard_history table for archiving dropped traders
-- 2026-03-02: Archive Strategy Implementation

CREATE TABLE IF NOT EXISTS leaderboard_history (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  season_id TEXT,
  handle TEXT,
  avatar_url TEXT,
  win_rate NUMERIC,
  max_drawdown NUMERIC,
  trades_count INTEGER,
  roi NUMERIC,
  pnl NUMERIC,
  followers INTEGER,
  roi_7d NUMERIC,
  roi_30d NUMERIC,
  roi_90d NUMERIC,
  win_rate_7d NUMERIC,
  win_rate_30d NUMERIC,
  win_rate_90d NUMERIC,
  max_drawdown_7d NUMERIC,
  max_drawdown_30d NUMERIC,
  max_drawdown_90d NUMERIC,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  snapshot_data JSONB,
  enrichment_status TEXT DEFAULT 'pending',
  UNIQUE(source, source_trader_id, season_id, archived_at)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_history_source ON leaderboard_history(source);
CREATE INDEX IF NOT EXISTS idx_history_trader ON leaderboard_history(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_history_archived ON leaderboard_history(archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_enrichment ON leaderboard_history(enrichment_status) WHERE enrichment_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_history_season ON leaderboard_history(source, season_id);

-- RLS policies (enable row level security)
ALTER TABLE leaderboard_history ENABLE ROW LEVEL SECURITY;

-- Allow public read access
CREATE POLICY "Allow public read access to history"
  ON leaderboard_history
  FOR SELECT
  TO public
  USING (true);

-- Allow service role full access
CREATE POLICY "Allow service role full access to history"
  ON leaderboard_history
  FOR ALL
  TO service_role
  USING (true);

-- Comments
COMMENT ON TABLE leaderboard_history IS 'Archive of traders who dropped from current leaderboards. Permanent retention.';
COMMENT ON COLUMN leaderboard_history.archived_at IS 'When the trader was moved to archive';
COMMENT ON COLUMN leaderboard_history.last_seen_at IS 'Last time trader appeared on active leaderboard';
COMMENT ON COLUMN leaderboard_history.snapshot_data IS 'Full JSON snapshot of trader data at archive time';
COMMENT ON COLUMN leaderboard_history.enrichment_status IS 'pending | complete | api_unavailable | failed';
