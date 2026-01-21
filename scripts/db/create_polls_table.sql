-- 创建投票相关表
-- polls 表：投票信息
-- poll_votes 表：投票记录

-- 创建 polls 表
CREATE TABLE IF NOT EXISTS polls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options JSONB NOT NULL, -- [{"text": "选项1", "votes": 0}, {"text": "选项2", "votes": 0}]
  type TEXT NOT NULL DEFAULT 'single', -- 'single' 或 'multiple'
  end_at TIMESTAMPTZ, -- 截止时间（可选）
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id)
);

-- 创建 poll_votes 表
CREATE TABLE IF NOT EXISTS poll_votes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL, -- 选择的选项索引
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(poll_id, user_id, option_index) -- 多选时允许同一用户选择多个选项
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_polls_post_id ON polls(post_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_id ON poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_user_id ON poll_votes(user_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_user ON poll_votes(poll_id, user_id);

-- RLS 策略
ALTER TABLE polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE poll_votes ENABLE ROW LEVEL SECURITY;

-- polls 表策略：所有人可查看，只有帖子作者可创建/更新
DROP POLICY IF EXISTS "Polls are viewable by everyone" ON polls;
DROP POLICY IF EXISTS "Post authors can create polls" ON polls;
DROP POLICY IF EXISTS "Post authors can update polls" ON polls;

CREATE POLICY "Polls are viewable by everyone"
  ON polls FOR SELECT
  USING (true);

CREATE POLICY "Post authors can create polls"
  ON polls FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM posts 
      WHERE posts.id = polls.post_id 
      AND posts.author_id = auth.uid()
    )
  );

CREATE POLICY "Post authors can update polls"
  ON polls FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM posts 
      WHERE posts.id = polls.post_id 
      AND posts.author_id = auth.uid()
    )
  );

-- poll_votes 表策略：所有人可查看，已登录用户可投票
DROP POLICY IF EXISTS "Poll votes are viewable by everyone" ON poll_votes;
DROP POLICY IF EXISTS "Authenticated users can vote" ON poll_votes;
DROP POLICY IF EXISTS "Users can delete their own votes" ON poll_votes;

CREATE POLICY "Poll votes are viewable by everyone"
  ON poll_votes FOR SELECT
  USING (true);

CREATE POLICY "Authenticated users can vote"
  ON poll_votes FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Users can delete their own votes"
  ON poll_votes FOR DELETE
  USING (auth.uid() = user_id);

-- 创建函数：自动更新投票计数
CREATE OR REPLACE FUNCTION update_poll_vote_count()
RETURNS TRIGGER AS $$
DECLARE
  option_idx INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    option_idx := NEW.option_index;
    UPDATE polls
    SET options = jsonb_set(
      options,
      ARRAY[option_idx::text, 'votes'],
      to_jsonb((options->option_idx->>'votes')::INTEGER + 1)
    ),
    updated_at = NOW()
    WHERE id = NEW.poll_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    option_idx := OLD.option_index;
    UPDATE polls
    SET options = jsonb_set(
      options,
      ARRAY[option_idx::text, 'votes'],
      to_jsonb(GREATEST(0, (options->option_idx->>'votes')::INTEGER - 1))
    ),
    updated_at = NOW()
    WHERE id = OLD.poll_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 创建触发器：自动更新投票计数
DROP TRIGGER IF EXISTS trigger_update_poll_vote_count ON poll_votes;
CREATE TRIGGER trigger_update_poll_vote_count
  AFTER INSERT OR DELETE ON poll_votes
  FOR EACH ROW
  EXECUTE FUNCTION update_poll_vote_count();

-- 创建更新时间触发器
DROP TRIGGER IF EXISTS update_polls_updated_at ON polls;
CREATE TRIGGER update_polls_updated_at
  BEFORE UPDATE ON polls
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

