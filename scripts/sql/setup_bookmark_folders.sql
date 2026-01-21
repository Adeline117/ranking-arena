-- 收藏夹系统

-- 1. 创建收藏夹表
CREATE TABLE IF NOT EXISTS bookmark_folders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  avatar_url TEXT,
  is_public BOOLEAN DEFAULT false,  -- 是否公开
  is_default BOOLEAN DEFAULT false, -- 是否是默认收藏夹
  post_count INTEGER DEFAULT 0,     -- 收藏的帖子数量
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)             -- 同一用户的收藏夹名称不能重复
);

-- 2. 修改 post_bookmarks 表，添加 folder_id
ALTER TABLE post_bookmarks ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES bookmark_folders(id) ON DELETE CASCADE;

-- 3. 创建索引
CREATE INDEX IF NOT EXISTS idx_bookmark_folders_user_id ON bookmark_folders(user_id);
CREATE INDEX IF NOT EXISTS idx_bookmark_folders_is_public ON bookmark_folders(is_public) WHERE is_public = true;
CREATE INDEX IF NOT EXISTS idx_post_bookmarks_folder_id ON post_bookmarks(folder_id);

-- 4. 创建触发器：更新收藏夹的帖子数量
CREATE OR REPLACE FUNCTION update_folder_post_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE bookmark_folders SET post_count = post_count + 1, updated_at = NOW() WHERE id = NEW.folder_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE bookmark_folders SET post_count = post_count - 1, updated_at = NOW() WHERE id = OLD.folder_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 分别创建 INSERT 和 DELETE 触发器以避免 NEW/OLD 引用问题
DROP TRIGGER IF EXISTS trg_update_folder_post_count ON post_bookmarks;
DROP TRIGGER IF EXISTS trg_update_folder_post_count_insert ON post_bookmarks;
DROP TRIGGER IF EXISTS trg_update_folder_post_count_delete ON post_bookmarks;

CREATE TRIGGER trg_update_folder_post_count_insert
AFTER INSERT ON post_bookmarks
FOR EACH ROW
WHEN (NEW.folder_id IS NOT NULL)
EXECUTE FUNCTION update_folder_post_count();

CREATE TRIGGER trg_update_folder_post_count_delete
AFTER DELETE ON post_bookmarks
FOR EACH ROW
WHEN (OLD.folder_id IS NOT NULL)
EXECUTE FUNCTION update_folder_post_count();

-- 5. 创建函数：确保每个用户有默认收藏夹
CREATE OR REPLACE FUNCTION ensure_default_bookmark_folder(p_user_id UUID)
RETURNS UUID AS $$
DECLARE
  v_folder_id UUID;
BEGIN
  -- 检查是否已有默认收藏夹
  SELECT id INTO v_folder_id FROM bookmark_folders 
  WHERE user_id = p_user_id AND is_default = true;
  
  -- 如果没有，创建一个
  IF v_folder_id IS NULL THEN
    INSERT INTO bookmark_folders (user_id, name, is_default)
    VALUES (p_user_id, '默认收藏夹', true)
    RETURNING id INTO v_folder_id;
  END IF;
  
  RETURN v_folder_id;
END;
$$ LANGUAGE plpgsql;

-- 6. RLS 策略
ALTER TABLE bookmark_folders ENABLE ROW LEVEL SECURITY;

-- 先删除已存在的策略
DROP POLICY IF EXISTS "Users can view own and public folders" ON bookmark_folders;
DROP POLICY IF EXISTS "Users can manage own folders" ON bookmark_folders;

-- 用户可以查看自己的收藏夹和公开的收藏夹
CREATE POLICY "Users can view own and public folders" ON bookmark_folders
  FOR SELECT USING (user_id = auth.uid() OR is_public = true);

-- 用户只能操作自己的收藏夹
CREATE POLICY "Users can manage own folders" ON bookmark_folders
  FOR ALL USING (user_id = auth.uid());

-- 验证
SELECT 'bookmark_folders 表创建成功' AS status;


