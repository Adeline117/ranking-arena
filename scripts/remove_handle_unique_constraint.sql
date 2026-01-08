-- 移除 user_profiles 表中 handle 的唯一性约束
-- 允许用户名重复，用户ID保持唯一（由 Supabase auth.users 自动生成）
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- 1. 检查并移除唯一性约束
DO $$ 
BEGIN
  -- 检查是否存在唯一性约束
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'user_profiles_handle_key'
  ) THEN
    -- 移除唯一性约束
    ALTER TABLE user_profiles DROP CONSTRAINT user_profiles_handle_key;
    RAISE NOTICE '已移除 handle 的唯一性约束';
  ELSE
    RAISE NOTICE 'handle 的唯一性约束不存在，无需移除';
  END IF;

  -- 检查是否存在唯一索引
  IF EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE indexname = 'idx_user_profiles_handle_unique'
  ) THEN
    -- 移除唯一索引
    DROP INDEX IF EXISTS idx_user_profiles_handle_unique;
    RAISE NOTICE '已移除 handle 的唯一索引';
  ELSE
    RAISE NOTICE 'handle 的唯一索引不存在，无需移除';
  END IF;
END $$;

-- 2. 创建普通索引（非唯一）以提高查询性能
CREATE INDEX IF NOT EXISTS idx_user_profiles_handle ON user_profiles(handle);

-- 3. 验证约束已移除
SELECT 
  conname AS constraint_name,
  contype AS constraint_type
FROM pg_constraint
WHERE conrelid = 'user_profiles'::regclass
  AND conname LIKE '%handle%';

-- 4. 验证索引
SELECT 
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'user_profiles'
  AND indexname LIKE '%handle%';

-- 5. 刷新 schema cache
NOTIFY pgrst, 'reload schema';


