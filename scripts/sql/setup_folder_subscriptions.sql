-- 收藏夹订阅系统
-- 允许用户收藏其他人的公开收藏夹

-- 1. 创建收藏夹订阅表
CREATE TABLE IF NOT EXISTS folder_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id UUID NOT NULL REFERENCES bookmark_folders(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, folder_id)  -- 同一用户不能重复订阅同一收藏夹
);

-- 2. 为 bookmark_folders 表添加订阅者数量字段
ALTER TABLE bookmark_folders ADD COLUMN IF NOT EXISTS subscriber_count INTEGER DEFAULT 0;

-- 3. 创建索引
CREATE INDEX IF NOT EXISTS idx_folder_subscriptions_user_id ON folder_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_folder_subscriptions_folder_id ON folder_subscriptions(folder_id);

-- 4. 创建触发器：更新收藏夹的订阅者数量
CREATE OR REPLACE FUNCTION update_folder_subscriber_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE bookmark_folders SET subscriber_count = subscriber_count + 1 WHERE id = NEW.folder_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE bookmark_folders SET subscriber_count = subscriber_count - 1 WHERE id = OLD.folder_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 删除已存在的触发器（如果有）
DROP TRIGGER IF EXISTS trg_update_folder_subscriber_count_insert ON folder_subscriptions;
DROP TRIGGER IF EXISTS trg_update_folder_subscriber_count_delete ON folder_subscriptions;

-- 创建 INSERT 触发器
CREATE TRIGGER trg_update_folder_subscriber_count_insert
AFTER INSERT ON folder_subscriptions
FOR EACH ROW
EXECUTE FUNCTION update_folder_subscriber_count();

-- 创建 DELETE 触发器
CREATE TRIGGER trg_update_folder_subscriber_count_delete
AFTER DELETE ON folder_subscriptions
FOR EACH ROW
EXECUTE FUNCTION update_folder_subscriber_count();

-- 5. RLS 策略
ALTER TABLE folder_subscriptions ENABLE ROW LEVEL SECURITY;

-- 删除已存在的策略（如果有）
DROP POLICY IF EXISTS "Users can view own subscriptions" ON folder_subscriptions;
DROP POLICY IF EXISTS "Users can manage own subscriptions" ON folder_subscriptions;
DROP POLICY IF EXISTS "Users can subscribe to public folders" ON folder_subscriptions;

-- 用户可以查看自己的订阅
CREATE POLICY "Users can view own subscriptions" ON folder_subscriptions
  FOR SELECT USING (user_id = auth.uid());

-- 用户可以订阅公开的收藏夹（INSERT时检查收藏夹是否公开）
CREATE POLICY "Users can subscribe to public folders" ON folder_subscriptions
  FOR INSERT WITH CHECK (
    user_id = auth.uid() AND
    EXISTS (
      SELECT 1 FROM bookmark_folders 
      WHERE id = folder_id AND is_public = true AND user_id != auth.uid()
    )
  );

-- 用户只能删除自己的订阅
CREATE POLICY "Users can delete own subscriptions" ON folder_subscriptions
  FOR DELETE USING (user_id = auth.uid());

-- 6. 创建函数：检查用户是否已订阅某收藏夹
CREATE OR REPLACE FUNCTION is_folder_subscribed(p_user_id UUID, p_folder_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM folder_subscriptions 
    WHERE user_id = p_user_id AND folder_id = p_folder_id
  );
END;
$$ LANGUAGE plpgsql;

-- 7. 创建函数：获取用户订阅的收藏夹列表
CREATE OR REPLACE FUNCTION get_subscribed_folders(p_user_id UUID)
RETURNS TABLE (
  id UUID,
  name TEXT,
  description TEXT,
  avatar_url TEXT,
  is_public BOOLEAN,
  post_count INTEGER,
  subscriber_count INTEGER,
  created_at TIMESTAMPTZ,
  owner_id UUID,
  owner_handle TEXT,
  owner_avatar_url TEXT,
  subscribed_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    bf.id,
    bf.name,
    bf.description,
    bf.avatar_url,
    bf.is_public,
    bf.post_count,
    bf.subscriber_count,
    bf.created_at,
    bf.user_id as owner_id,
    up.handle as owner_handle,
    up.avatar_url as owner_avatar_url,
    fs.created_at as subscribed_at
  FROM folder_subscriptions fs
  JOIN bookmark_folders bf ON bf.id = fs.folder_id
  LEFT JOIN user_profiles up ON up.id = bf.user_id
  WHERE fs.user_id = p_user_id AND bf.is_public = true
  ORDER BY fs.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- 验证
SELECT 'folder_subscriptions 表创建成功' AS status;
