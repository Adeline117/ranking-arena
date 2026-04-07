-- Multi-emoji reactions on posts (separate from post_likes which drives hot_score)
-- Pattern from Rocket.Chat/Misskey: any emoji reaction, not just like/dislike

CREATE TABLE IF NOT EXISTS post_emoji_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 10),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, user_id, emoji)
);

CREATE INDEX idx_post_emoji_reactions_post ON post_emoji_reactions(post_id);
CREATE INDEX idx_post_emoji_reactions_user ON post_emoji_reactions(user_id);

ALTER TABLE post_emoji_reactions ENABLE ROW LEVEL SECURITY;

-- RLS: anyone can read, only authenticated users can insert/delete their own
CREATE POLICY "Anyone can read emoji reactions"
  ON post_emoji_reactions FOR SELECT USING (true);

CREATE POLICY "Users can add their own emoji reactions"
  ON post_emoji_reactions FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can remove their own emoji reactions"
  ON post_emoji_reactions FOR DELETE USING (auth.uid() = user_id);

-- Comment emoji reactions
CREATE TABLE IF NOT EXISTS comment_emoji_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id UUID NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 10),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(comment_id, user_id, emoji)
);

CREATE INDEX idx_comment_emoji_reactions_comment ON comment_emoji_reactions(comment_id);

ALTER TABLE comment_emoji_reactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read comment emoji reactions"
  ON comment_emoji_reactions FOR SELECT USING (true);

CREATE POLICY "Users can add their own comment emoji reactions"
  ON comment_emoji_reactions FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can remove their own comment emoji reactions"
  ON comment_emoji_reactions FOR DELETE USING (auth.uid() = user_id);
