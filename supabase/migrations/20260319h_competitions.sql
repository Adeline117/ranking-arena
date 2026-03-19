-- Trading Competitions MVP
-- Allows users to create and join trading competitions

-- Competitions table
CREATE TABLE IF NOT EXISTS competitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  creator_id UUID NOT NULL REFERENCES auth.users(id),
  metric TEXT NOT NULL DEFAULT 'roi', -- roi, pnl, sharpe, max_drawdown
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  entry_fee_cents INT DEFAULT 0, -- 0 = free
  max_participants INT DEFAULT 100,
  prize_pool_cents INT DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'upcoming', -- upcoming, active, completed, cancelled
  rules JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Competition entries table
CREATE TABLE IF NOT EXISTS competition_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  trader_id TEXT NOT NULL, -- trader source_trader_id
  platform TEXT NOT NULL, -- source/exchange
  baseline_value NUMERIC, -- value at start (ROI/PnL at entry time)
  current_value NUMERIC, -- latest value
  rank INT,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(competition_id, user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_competitions_status ON competitions(status);
CREATE INDEX IF NOT EXISTS idx_competitions_start_at ON competitions(start_at);
CREATE INDEX IF NOT EXISTS idx_competitions_end_at ON competitions(end_at);
CREATE INDEX IF NOT EXISTS idx_competitions_creator ON competitions(creator_id);
CREATE INDEX IF NOT EXISTS idx_competition_entries_comp ON competition_entries(competition_id);
CREATE INDEX IF NOT EXISTS idx_competition_entries_user ON competition_entries(user_id);

-- Enable RLS
ALTER TABLE competitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE competition_entries ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Public read competitions" ON competitions FOR SELECT USING (true);
CREATE POLICY "Auth create competitions" ON competitions FOR INSERT WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "Creator update competitions" ON competitions FOR UPDATE USING (auth.uid() = creator_id);

CREATE POLICY "Public read entries" ON competition_entries FOR SELECT USING (true);
CREATE POLICY "Auth join competitions" ON competition_entries FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Allow service role to update entries (for cron job)
-- Service role bypasses RLS by default, so no extra policy needed
