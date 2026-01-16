-- 修复 posts 表和创建 polls 表

-- 1. 创建 polls 表
CREATE TABLE IF NOT EXISTS polls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options JSONB NOT NULL DEFAULT '[]',
  type TEXT DEFAULT 'single', -- single: 单选, multiple: 多选
  end_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(post_id)
);

-- 添加 post_id 字段（如果表已存在但缺少该字段）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'polls' AND column_name = 'post_id'
  ) THEN
    ALTER TABLE polls ADD COLUMN post_id UUID REFERENCES posts(id) ON DELETE CASCADE;
    ALTER TABLE polls ADD CONSTRAINT polls_post_id_unique UNIQUE (post_id);
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'polls' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE polls ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
  END IF;
END $$;

-- 2. 添加 posts 表缺失的字段
DO $$
BEGIN
  -- poll_id 字段
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'poll_id'
  ) THEN
    ALTER TABLE posts ADD COLUMN poll_id UUID REFERENCES polls(id);
  END IF;

  -- images 字段
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'images'
  ) THEN
    ALTER TABLE posts ADD COLUMN images TEXT[];
  END IF;

  -- links 字段
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'links'
  ) THEN
    ALTER TABLE posts ADD COLUMN links JSONB;
  END IF;
END $$;

-- 3. 创建 poll_votes 表（用户对 poll 的投票）
CREATE TABLE IF NOT EXISTS poll_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  option_index INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(poll_id, user_id, option_index)
);

-- 4. 创建索引
CREATE INDEX IF NOT EXISTS idx_polls_created_at ON polls(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_id ON poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_user_id ON poll_votes(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_poll_id ON posts(poll_id);

-- 5. RLS 策略
ALTER TABLE polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE poll_votes ENABLE ROW LEVEL SECURITY;

-- polls 表策略
DROP POLICY IF EXISTS "Anyone can view polls" ON polls;
CREATE POLICY "Anyone can view polls" ON polls FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated users can create polls" ON polls;
CREATE POLICY "Authenticated users can create polls" ON polls FOR INSERT WITH CHECK (true);

-- poll_votes 表策略
DROP POLICY IF EXISTS "Anyone can view poll votes" ON poll_votes;
CREATE POLICY "Anyone can view poll votes" ON poll_votes FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can vote" ON poll_votes;
CREATE POLICY "Users can vote" ON poll_votes FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Users can change vote" ON poll_votes;
CREATE POLICY "Users can change vote" ON poll_votes FOR DELETE USING (true);

-- 6. 更新投票计数的触发器
CREATE OR REPLACE FUNCTION update_poll_option_votes()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE polls 
    SET options = (
      SELECT jsonb_agg(
        CASE 
          WHEN (elem->>'index')::int = NEW.option_index 
          THEN jsonb_set(elem, '{votes}', to_jsonb(COALESCE((elem->>'votes')::int, 0) + 1))
          ELSE elem 
        END
      )
      FROM jsonb_array_elements(options) elem
    )
    WHERE id = NEW.poll_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE polls 
    SET options = (
      SELECT jsonb_agg(
        CASE 
          WHEN (elem->>'index')::int = OLD.option_index 
          THEN jsonb_set(elem, '{votes}', to_jsonb(GREATEST(0, COALESCE((elem->>'votes')::int, 0) - 1)))
          ELSE elem 
        END
      )
      FROM jsonb_array_elements(options) elem
    )
    WHERE id = OLD.poll_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_poll_votes ON poll_votes;
CREATE TRIGGER trigger_update_poll_votes
AFTER INSERT OR DELETE ON poll_votes
FOR EACH ROW
EXECUTE FUNCTION update_poll_option_votes();

