-- Hashtag registry
CREATE TABLE IF NOT EXISTS hashtags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag text NOT NULL UNIQUE,
  post_count integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Posts <-> Hashtags join
CREATE TABLE IF NOT EXISTS post_hashtags (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  hashtag_id uuid NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, hashtag_id)
);

CREATE INDEX idx_post_hashtags_hashtag ON post_hashtags(hashtag_id);
CREATE INDEX idx_hashtags_count ON hashtags(post_count DESC);

ALTER TABLE hashtags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read hashtags" ON hashtags FOR SELECT USING (true);
CREATE POLICY "Authenticated users can insert hashtags" ON hashtags FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Service role can update hashtags" ON hashtags FOR UPDATE USING (true);

ALTER TABLE post_hashtags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read post_hashtags" ON post_hashtags FOR SELECT USING (true);
CREATE POLICY "Authenticated users can insert post_hashtags" ON post_hashtags FOR INSERT WITH CHECK (auth.role() = 'authenticated');
