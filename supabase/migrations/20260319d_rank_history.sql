-- Rank history table for trajectory sparklines
-- Stores daily rank snapshots for top 500 traders per season

CREATE TABLE IF NOT EXISTS rank_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  trader_key TEXT NOT NULL,
  period TEXT NOT NULL,           -- '7D', '30D', '90D'
  rank INTEGER NOT NULL,
  arena_score DECIMAL(8, 2),
  snapshot_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, trader_key, period, snapshot_date)
);

-- Index for efficient lookups by trader + period + date range
CREATE INDEX IF NOT EXISTS idx_rank_history_trader_period
  ON rank_history(platform, trader_key, period, snapshot_date DESC);

-- Index for date-based cleanup
CREATE INDEX IF NOT EXISTS idx_rank_history_date
  ON rank_history(snapshot_date DESC);

-- RLS
ALTER TABLE rank_history ENABLE ROW LEVEL SECURITY;

-- Public read access (rank data is not sensitive)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'rank_history' AND policyname = 'rank_history_select'
  ) THEN
    CREATE POLICY "rank_history_select" ON rank_history
      FOR SELECT USING (true);
  END IF;
END $$;

-- Service role can insert/update/delete (for cron jobs)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'rank_history' AND policyname = 'rank_history_service_write'
  ) THEN
    CREATE POLICY "rank_history_service_write" ON rank_history
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE rank_history IS 'Daily rank snapshots for trajectory sparklines. Top 500 per season, retained 30 days.';
