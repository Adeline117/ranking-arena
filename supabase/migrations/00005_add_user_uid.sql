-- 添加数字用户 UID 字段
-- 用于展示简洁的用户编号，支持按 UID 搜索用户

-- 1. 添加 uid 字段（允许手动设置，但有默认自增）
ALTER TABLE user_profiles 
ADD COLUMN IF NOT EXISTS uid BIGINT UNIQUE;

-- 2. 创建序列，从 10001 开始（留出前面的号给特殊用户）
CREATE SEQUENCE IF NOT EXISTS user_uid_seq START WITH 10001;

-- 3. 设置默认值（新用户自动分配）
ALTER TABLE user_profiles 
ALTER COLUMN uid SET DEFAULT nextval('user_uid_seq');

-- 4. 为现有用户分配 UID（如果还没有）
-- 先给特定用户设置固定 UID
UPDATE user_profiles SET uid = 1 WHERE handle = 'adeline' AND uid IS NULL;
UPDATE user_profiles SET uid = 2 WHERE handle = 'test' AND uid IS NULL;

-- 其他现有用户按创建时间顺序分配
WITH ordered_users AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) + 10000 AS new_uid
  FROM user_profiles
  WHERE uid IS NULL
)
UPDATE user_profiles up
SET uid = ou.new_uid
FROM ordered_users ou
WHERE up.id = ou.id;

-- 5. 更新序列值到当前最大值之后
SELECT setval('user_uid_seq', COALESCE((SELECT MAX(uid) FROM user_profiles), 10000) + 1, false);

-- 6. 创建索引以加速按 UID 搜索
CREATE INDEX IF NOT EXISTS idx_user_profiles_uid ON user_profiles(uid);

-- 7. 添加注释
COMMENT ON COLUMN user_profiles.uid IS '用户展示编号，用于简洁显示和搜索';
