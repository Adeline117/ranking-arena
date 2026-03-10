-- Trader watchlist: users can save traders to watch
CREATE TABLE IF NOT EXISTS trader_watchlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source text NOT NULL,
  source_trader_id text NOT NULL,
  handle text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source, source_trader_id)
);

-- RLS
ALTER TABLE trader_watchlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own watchlist"
  ON trader_watchlist FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own watchlist"
  ON trader_watchlist FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own watchlist"
  ON trader_watchlist FOR DELETE
  USING (auth.uid() = user_id);

-- Index for fast lookups
CREATE INDEX idx_trader_watchlist_user ON trader_watchlist(user_id);
CREATE INDEX idx_trader_watchlist_trader ON trader_watchlist(source, source_trader_id);
