-- 用户活动追踪
-- user_activity: 记录所有用户行为事件
-- user_streaks: 追踪用户连续活跃天数

CREATE TABLE IF NOT EXISTS user_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN (
    'page_view', 'search', 'follow', 'unfollow',
    'like', 'post', 'compare', 'library_view', 'trade_copy'
  )),
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_activity_user_action_time
  ON user_activity (user_id, action, created_at);

CREATE INDEX idx_user_activity_created_at
  ON user_activity (created_at);

CREATE TABLE IF NOT EXISTS user_streaks (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  current_streak int NOT NULL DEFAULT 0,
  longest_streak int NOT NULL DEFAULT 0,
  last_active_date date,
  total_active_days int NOT NULL DEFAULT 0
);

-- RLS
ALTER TABLE user_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_streaks ENABLE ROW LEVEL SECURITY;

-- user_activity: 用户只能读自己的活动, 插入自己的活动
CREATE POLICY "user_activity_select_own"
  ON user_activity FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "user_activity_insert_own"
  ON user_activity FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- user_streaks: 任何人可读(用于展示), 只有自己可更新
CREATE POLICY "user_streaks_select_all"
  ON user_streaks FOR SELECT
  USING (true);

CREATE POLICY "user_streaks_insert_own"
  ON user_streaks FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_streaks_update_own"
  ON user_streaks FOR UPDATE
  USING (auth.uid() = user_id);

-- 触发器: 插入活动时自动更新连续天数
CREATE OR REPLACE FUNCTION update_user_streak()
RETURNS TRIGGER AS $$
DECLARE
  v_today date := CURRENT_DATE;
  v_rec user_streaks%ROWTYPE;
BEGIN
  SELECT * INTO v_rec FROM user_streaks WHERE user_id = NEW.user_id;

  IF NOT FOUND THEN
    INSERT INTO user_streaks (user_id, current_streak, longest_streak, last_active_date, total_active_days)
    VALUES (NEW.user_id, 1, 1, v_today, 1);
  ELSIF v_rec.last_active_date = v_today THEN
    -- 今天已记录, 跳过
    NULL;
  ELSIF v_rec.last_active_date = v_today - 1 THEN
    -- 连续活跃
    UPDATE user_streaks SET
      current_streak = v_rec.current_streak + 1,
      longest_streak = GREATEST(v_rec.longest_streak, v_rec.current_streak + 1),
      last_active_date = v_today,
      total_active_days = v_rec.total_active_days + 1
    WHERE user_id = NEW.user_id;
  ELSE
    -- 断了, 重置
    UPDATE user_streaks SET
      current_streak = 1,
      longest_streak = GREATEST(v_rec.longest_streak, 1),
      last_active_date = v_today,
      total_active_days = v_rec.total_active_days + 1
    WHERE user_id = NEW.user_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_update_user_streak
  AFTER INSERT ON user_activity
  FOR EACH ROW
  EXECUTE FUNCTION update_user_streak();
