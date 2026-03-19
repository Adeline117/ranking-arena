-- Create leaderboard_ranks table (if not exists)
-- This table was originally created via Supabase UI. This migration ensures
-- it exists in version control for new environments and schema auditing.

CREATE TABLE IF NOT EXISTS leaderboard_ranks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id TEXT NOT NULL,                          -- '7D', '30D', '90D'
  source TEXT NOT NULL,                             -- platform name (binance_futures, hyperliquid, etc.)
  source_type TEXT,                                 -- 'futures', 'spot', 'web3'
  source_trader_id TEXT NOT NULL,                   -- trader ID on platform
  rank INTEGER CHECK (rank IS NULL OR rank > 0),
  arena_score NUMERIC(10, 2),                       -- 0-100 composite score
  roi NUMERIC(12, 4),                               -- ROI percentage
  pnl NUMERIC(18, 2),                               -- PnL in USD
  win_rate NUMERIC(5, 2) CHECK (win_rate IS NULL OR (win_rate >= 0 AND win_rate <= 100)),
  max_drawdown NUMERIC(5, 2) CHECK (max_drawdown IS NULL OR (max_drawdown >= -100 AND max_drawdown <= 0)),
  followers INTEGER CHECK (followers IS NULL OR followers >= 0),
  trades_count INTEGER,
  handle TEXT,                                      -- trader display name
  avatar_url TEXT,
  computed_at TIMESTAMPTZ,                          -- when this row was last computed
  -- Score sub-components
  profitability_score NUMERIC(6, 2),
  risk_control_score NUMERIC(6, 2),
  execution_score NUMERIC(6, 2),
  score_completeness TEXT,                          -- stores pnlScore (historical naming)
  -- Trading style
  trading_style TEXT,
  avg_holding_hours NUMERIC(10, 2),
  style_confidence NUMERIC(6, 4),
  -- Risk metrics
  sharpe_ratio NUMERIC(10, 4),
  -- Metadata
  trader_type TEXT,                                 -- 'human', 'bot', or NULL
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (season_id, source, source_trader_id)
);

-- Core query indexes
CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_season_score
  ON leaderboard_ranks (season_id, arena_score DESC);

CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_source_season_score
  ON leaderboard_ranks (source, season_id, arena_score DESC);

CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_season_rank
  ON leaderboard_ranks (season_id, rank ASC);

CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_trader_type
  ON leaderboard_ranks (season_id, trader_type) WHERE trader_type IS NOT NULL;

-- RLS: public read access
ALTER TABLE leaderboard_ranks ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'leaderboard_ranks' AND policyname = 'Public read leaderboard_ranks'
  ) THEN
    CREATE POLICY "Public read leaderboard_ranks" ON leaderboard_ranks FOR SELECT USING (true);
  END IF;
END $$;
