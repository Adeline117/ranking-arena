-- 用户私信和关注系统数据库表结构
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 用户互相关注表 (user_follows)
-- 用于用户之间的关注关系，区别于 trader_follows (用户关注交易员)
-- ============================================
CREATE TABLE IF NOT EXISTS user_follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- 确保不能关注自己，且关注关系唯一
  CONSTRAINT no_self_follow CHECK (follower_id != following_id),
  UNIQUE(follower_id, following_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON user_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_following ON user_follows(following_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_created ON user_follows(created_at);

-- RLS 策略
ALTER TABLE user_follows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "User follows are viewable by everyone" ON user_follows;
DROP POLICY IF EXISTS "Users can follow others" ON user_follows;
DROP POLICY IF EXISTS "Users can unfollow others" ON user_follows;

-- 任何人都可以查看关注关系（用于判断互相关注等）
CREATE POLICY "User follows are viewable by everyone"
  ON user_follows FOR SELECT
  USING (true);

-- 用户可以关注他人
CREATE POLICY "Users can follow others"
  ON user_follows FOR INSERT
  WITH CHECK (auth.uid() = follower_id);

-- 用户可以取消关注
CREATE POLICY "Users can unfollow others"
  ON user_follows FOR DELETE
  USING (auth.uid() = follower_id);

-- ============================================
-- 2. 私信会话表 (conversations)
-- 存储两个用户之间的会话
-- ============================================
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user1_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user2_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_message_preview TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- 确保 user1_id < user2_id 以避免重复
  CONSTRAINT users_ordered CHECK (user1_id < user2_id),
  UNIQUE(user1_id, user2_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_conversations_user1 ON conversations(user1_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user2 ON conversations(user2_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at DESC);

-- RLS 策略
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own conversations" ON conversations;
DROP POLICY IF EXISTS "Users can create conversations" ON conversations;
DROP POLICY IF EXISTS "Users can update their own conversations" ON conversations;

CREATE POLICY "Users can view their own conversations"
  ON conversations FOR SELECT
  USING (auth.uid() = user1_id OR auth.uid() = user2_id);

CREATE POLICY "Users can create conversations"
  ON conversations FOR INSERT
  WITH CHECK (auth.uid() = user1_id OR auth.uid() = user2_id);

CREATE POLICY "Users can update their own conversations"
  ON conversations FOR UPDATE
  USING (auth.uid() = user1_id OR auth.uid() = user2_id);

-- ============================================
-- 3. 私信消息表 (direct_messages)
-- ============================================
CREATE TABLE IF NOT EXISTS direct_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_dm_conversation ON direct_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_dm_sender ON direct_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_dm_receiver ON direct_messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_dm_created ON direct_messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_unread ON direct_messages(receiver_id, read) WHERE read = false;

-- RLS 策略
ALTER TABLE direct_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own messages" ON direct_messages;
DROP POLICY IF EXISTS "Users can send messages" ON direct_messages;
DROP POLICY IF EXISTS "Users can update their own received messages" ON direct_messages;

CREATE POLICY "Users can view their own messages"
  ON direct_messages FOR SELECT
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

CREATE POLICY "Users can send messages"
  ON direct_messages FOR INSERT
  WITH CHECK (auth.uid() = sender_id);

-- 只有接收者可以更新（标记为已读）
CREATE POLICY "Users can update their own received messages"
  ON direct_messages FOR UPDATE
  USING (auth.uid() = receiver_id);

-- ============================================
-- 4. 更新 user_profiles 表添加隐私设置字段
-- ============================================
DO $$ 
BEGIN
  -- 添加隐私设置：是否展示关注列表
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'show_following'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN show_following BOOLEAN DEFAULT true;
  END IF;

  -- 添加隐私设置：是否展示被关注列表
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'show_followers'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN show_followers BOOLEAN DEFAULT true;
  END IF;

  -- 添加隐私设置：私信权限 ('all' = 所有人, 'mutual' = 仅互相关注, 'none' = 关闭私信)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'dm_permission'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN dm_permission TEXT DEFAULT 'mutual' CHECK (dm_permission IN ('all', 'mutual', 'none'));
  END IF;

  -- 添加通知设置：私信通知
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'notify_message'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN notify_message BOOLEAN DEFAULT true;
  END IF;
END $$;

-- ============================================
-- 5. 创建函数：检查是否互相关注
-- ============================================
CREATE OR REPLACE FUNCTION check_mutual_follow(user_a UUID, user_b UUID)
RETURNS BOOLEAN AS $$
DECLARE
  a_follows_b BOOLEAN;
  b_follows_a BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM user_follows 
    WHERE follower_id = user_a AND following_id = user_b
  ) INTO a_follows_b;
  
  SELECT EXISTS (
    SELECT 1 FROM user_follows 
    WHERE follower_id = user_b AND following_id = user_a
  ) INTO b_follows_a;
  
  RETURN a_follows_b AND b_follows_a;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 6. 创建函数：获取用户发送给特定用户的消息数量（非互关场景限制）
-- 用于限制非互关用户只能发送3条消息
-- ============================================
CREATE OR REPLACE FUNCTION get_dm_count_before_reply(sender UUID, receiver UUID)
RETURNS INTEGER AS $$
DECLARE
  msg_count INTEGER;
  receiver_replied BOOLEAN;
BEGIN
  -- 检查接收者是否回复过
  SELECT EXISTS (
    SELECT 1 FROM direct_messages 
    WHERE sender_id = receiver AND receiver_id = sender
  ) INTO receiver_replied;
  
  -- 如果已回复，返回0（不限制）
  IF receiver_replied THEN
    RETURN 0;
  END IF;
  
  -- 否则返回发送者已发送的消息数
  SELECT COUNT(*) INTO msg_count
  FROM direct_messages
  WHERE sender_id = sender AND receiver_id = receiver;
  
  RETURN msg_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 7. 触发器：自动更新会话的最后消息时间和预览
-- ============================================
CREATE OR REPLACE FUNCTION update_conversation_on_message()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversations
  SET 
    last_message_at = NEW.created_at,
    last_message_preview = LEFT(NEW.content, 100)
  WHERE id = NEW.conversation_id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_dm_sent ON direct_messages;
CREATE TRIGGER on_dm_sent
  AFTER INSERT ON direct_messages
  FOR EACH ROW
  EXECUTE FUNCTION update_conversation_on_message();

-- ============================================
-- 8. 触发器：用户关注时创建通知
-- ============================================
CREATE OR REPLACE FUNCTION create_user_follow_notification()
RETURNS TRIGGER AS $$
DECLARE
  follower_handle TEXT;
  following_notify_follow BOOLEAN;
BEGIN
  -- 获取关注者的handle
  SELECT handle INTO follower_handle FROM user_profiles WHERE id = NEW.follower_id;
  
  -- 检查被关注者是否开启关注通知
  SELECT COALESCE(notify_follow, true) INTO following_notify_follow 
  FROM user_profiles WHERE id = NEW.following_id;
  
  -- 如果开启了通知，创建通知
  IF following_notify_follow THEN
    INSERT INTO notifications (user_id, type, title, message, link, actor_id)
    VALUES (
      NEW.following_id,
      'follow',
      '新粉丝',
      COALESCE(follower_handle, '有人') || ' 关注了你',
      '/u/' || COALESCE(follower_handle, NEW.follower_id::TEXT),
      NEW.follower_id
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_user_follow ON user_follows;
CREATE TRIGGER on_user_follow
  AFTER INSERT ON user_follows
  FOR EACH ROW
  EXECUTE FUNCTION create_user_follow_notification();

-- ============================================
-- 9. 触发器：收到私信时创建通知
-- ============================================
CREATE OR REPLACE FUNCTION create_message_notification()
RETURNS TRIGGER AS $$
DECLARE
  sender_handle TEXT;
  receiver_notify_message BOOLEAN;
BEGIN
  -- 获取发送者的handle
  SELECT handle INTO sender_handle FROM user_profiles WHERE id = NEW.sender_id;
  
  -- 检查接收者是否开启私信通知
  SELECT COALESCE(notify_message, true) INTO receiver_notify_message 
  FROM user_profiles WHERE id = NEW.receiver_id;
  
  -- 如果开启了通知，创建通知
  IF receiver_notify_message THEN
    INSERT INTO notifications (user_id, type, title, message, link, actor_id, reference_id)
    VALUES (
      NEW.receiver_id,
      'message',
      '新私信',
      COALESCE(sender_handle, '有人') || ' 给你发送了一条私信',
      '/messages/' || NEW.conversation_id,
      NEW.sender_id,
      NEW.conversation_id
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_dm_received ON direct_messages;
CREATE TRIGGER on_dm_received
  AFTER INSERT ON direct_messages
  FOR EACH ROW
  EXECUTE FUNCTION create_message_notification();

-- ============================================
-- 10. 更新 notifications 表的 type 检查约束
-- ============================================
DO $$
BEGIN
  -- 删除旧约束
  ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  
  -- 添加新约束，包含 'message' 类型
  ALTER TABLE notifications ADD CONSTRAINT notifications_type_check 
    CHECK (type IN ('follow', 'like', 'comment', 'system', 'mention', 'message'));
EXCEPTION
  WHEN others THEN
    RAISE NOTICE 'Could not update notifications type constraint: %', SQLERRM;
END $$;

-- ============================================
-- 11. 创建视图：用户关注统计
-- ============================================
CREATE OR REPLACE VIEW user_follow_counts AS
SELECT 
  u.id,
  u.handle,
  COALESCE(followers.count, 0) as followers_count,
  COALESCE(following.count, 0) as following_count
FROM user_profiles u
LEFT JOIN (
  SELECT following_id, COUNT(*) as count
  FROM user_follows
  GROUP BY following_id
) followers ON u.id = followers.following_id
LEFT JOIN (
  SELECT follower_id, COUNT(*) as count
  FROM user_follows
  GROUP BY follower_id
) following ON u.id = following.follower_id;

-- ============================================
-- 12. 创建函数：获取或创建会话
-- ============================================
CREATE OR REPLACE FUNCTION get_or_create_conversation(user_a UUID, user_b UUID)
RETURNS UUID AS $$
DECLARE
  conv_id UUID;
  ordered_user1 UUID;
  ordered_user2 UUID;
BEGIN
  -- 确保 user1 < user2
  IF user_a < user_b THEN
    ordered_user1 := user_a;
    ordered_user2 := user_b;
  ELSE
    ordered_user1 := user_b;
    ordered_user2 := user_a;
  END IF;
  
  -- 尝试查找现有会话
  SELECT id INTO conv_id
  FROM conversations
  WHERE user1_id = ordered_user1 AND user2_id = ordered_user2;
  
  -- 如果不存在，创建新会话
  IF conv_id IS NULL THEN
    INSERT INTO conversations (user1_id, user2_id)
    VALUES (ordered_user1, ordered_user2)
    RETURNING id INTO conv_id;
  END IF;
  
  RETURN conv_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 完成
-- ============================================
-- 运行此脚本后，私信和用户关注系统的数据库结构配置完成
-- 功能说明：
-- 1. 用户可以互相关注
-- 2. 默认展示关注和被关注列表，可在隐私设置中关闭
-- 3. 互相关注可以无限私信
-- 4. 非互相关注只能发送3条消息，对方回复后才能继续

