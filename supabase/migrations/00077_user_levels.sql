-- 用户等级系统
-- user_levels表
CREATE TABLE IF NOT EXISTS user_levels (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  exp INTEGER DEFAULT 0,
  level INTEGER DEFAULT 1,
  daily_exp_earned INTEGER DEFAULT 0,
  daily_exp_date DATE DEFAULT CURRENT_DATE,
  is_pro BOOLEAN DEFAULT false,
  pro_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- exp_transactions表（记录EXP来源）
CREATE TABLE IF NOT EXISTS exp_transactions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  action TEXT NOT NULL,
  exp_amount INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exp_transactions_user ON exp_transactions(user_id, created_at DESC);

-- RLS
ALTER TABLE user_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE exp_transactions ENABLE ROW LEVEL SECURITY;

-- 用户可以读取自己的等级信息
CREATE POLICY "users_read_own_level" ON user_levels
  FOR SELECT USING (auth.uid() = user_id);

-- 所有人可以读取等级（用于显示）
CREATE POLICY "public_read_levels" ON user_levels
  FOR SELECT USING (true);

-- 服务端可以插入/更新
CREATE POLICY "service_manage_levels" ON user_levels
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "service_manage_exp_transactions" ON exp_transactions
  FOR ALL USING (true) WITH CHECK (true);
