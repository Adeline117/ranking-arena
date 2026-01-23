-- Create trader_links table for multi-account linking
CREATE TABLE IF NOT EXISTS trader_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  source TEXT NOT NULL,
  handle TEXT,
  verified_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(trader_id, source)
);

-- Row Level Security
ALTER TABLE trader_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own links"
  ON trader_links FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own links"
  ON trader_links FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own links"
  ON trader_links FOR DELETE
  USING (auth.uid() = user_id);

-- Index for faster lookups
CREATE INDEX idx_trader_links_user_id ON trader_links(user_id);
CREATE INDEX idx_trader_links_trader_source ON trader_links(trader_id, source);
