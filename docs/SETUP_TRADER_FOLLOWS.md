# 设置 trader_follows 表

## 问题

如果看到错误：`Could not find the table 'public.trader_follows'`，说明 `trader_follows` 表还没有创建。

## 解决方案

在 Supabase Dashboard 的 SQL Editor 中运行以下脚本：

```sql
-- 运行 scripts/setup_trader_follows.sql
```

或者直接运行以下 SQL：

```sql
-- 创建 trader_follows 表
CREATE TABLE IF NOT EXISTS trader_follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  source TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, trader_id)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_trader_follows_user_id ON trader_follows(user_id);
CREATE INDEX IF NOT EXISTS idx_trader_follows_trader_id ON trader_follows(trader_id);

-- 设置 RLS 策略
ALTER TABLE trader_follows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view trader follows" ON trader_follows;
CREATE POLICY "Anyone can view trader follows"
  ON trader_follows FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Users can follow traders" ON trader_follows;
CREATE POLICY "Users can follow traders"
  ON trader_follows FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can unfollow traders" ON trader_follows;
CREATE POLICY "Users can unfollow traders"
  ON trader_follows FOR DELETE
  USING (auth.uid() = user_id);
```

## 说明

- `trader_follows` 表用于存储 Arena 用户对 Trader 的关注关系
- 所有 trader 的粉丝数**只能来源 Arena 注册用户的关注**
- 原平台的粉丝数据不做数，只统计 Arena 用户的关注

## 验证

运行以下查询验证表是否创建成功：

```sql
SELECT * FROM trader_follows LIMIT 5;
```

如果查询成功，表已创建。

