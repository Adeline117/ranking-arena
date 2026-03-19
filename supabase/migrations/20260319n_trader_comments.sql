-- Trader comments/reviews: users can leave reviews on any trader's profile page
CREATE TABLE IF NOT EXISTS trader_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_source text NOT NULL,
  trader_source_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL CHECK (length(content) >= 1 AND length(content) <= 2000),
  rating smallint CHECK (rating >= 1 AND rating <= 5),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_trader_comments_trader ON trader_comments(trader_source, trader_source_id, created_at DESC);
CREATE INDEX idx_trader_comments_user ON trader_comments(user_id);

ALTER TABLE trader_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read trader comments" ON trader_comments FOR SELECT USING (true);
CREATE POLICY "Authenticated users can create comments" ON trader_comments FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own comments" ON trader_comments FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own comments" ON trader_comments FOR DELETE USING (auth.uid() = user_id);
