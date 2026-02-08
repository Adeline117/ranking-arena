-- 00070_notifications.sql
-- 通知系统增强：确保 notifications 表有所有需要的列和索引

-- 添加缺失的列（如果还没有的话）
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read BOOLEAN DEFAULT FALSE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS reference_id TEXT;

-- 迁移旧数据（如果存在旧列）
DO $$
BEGIN
  -- 如果 content 列存在，把数据迁移到 message
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'content') THEN
    UPDATE notifications SET message = content WHERE message IS NULL AND content IS NOT NULL;
  END IF;
  -- 如果 is_read 列存在，把数据迁移到 read
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'is_read') THEN
    UPDATE notifications SET read = is_read WHERE read IS NULL OR read = FALSE;
  END IF;
END $$;

-- 复合索引：用户+已读+时间（覆盖常用查询）
CREATE INDEX IF NOT EXISTS idx_notifications_user_read_created
  ON notifications (user_id, read, created_at DESC);

-- 删除冗余的旧索引（新复合索引覆盖了这些场景）
DROP INDEX IF EXISTS idx_notifications_is_read;

-- RLS 策略（幂等）
DO $$
BEGIN
  -- 确保 INSERT 策略存在（service_role 或 server 端创建通知）
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'notifications' AND policyname = 'Service can insert notifications'
  ) THEN
    CREATE POLICY "Service can insert notifications"
      ON notifications FOR INSERT
      WITH CHECK (true);
  END IF;

  -- 确保 DELETE 策略存在
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'notifications' AND policyname = 'Users can delete their own notifications'
  ) THEN
    CREATE POLICY "Users can delete their own notifications"
      ON notifications FOR DELETE
      USING (auth.uid() = user_id);
  END IF;
END $$;
