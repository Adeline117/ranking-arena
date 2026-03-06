-- Growth Engineering: feedback, analytics, user_preferences, notifications
-- Created: 2026-03-05

-- 1. Feedback table
CREATE TABLE IF NOT EXISTS feedback (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  message text NOT NULL,
  page_url text,
  user_agent text,
  screenshot_url text,
  status text DEFAULT 'new' CHECK (status IN ('new', 'read', 'resolved', 'dismissed')),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can insert feedback" ON feedback FOR INSERT WITH CHECK (true);
CREATE POLICY "Service manage feedback" ON feedback FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX idx_feedback_created_at ON feedback(created_at DESC);
CREATE INDEX idx_feedback_status ON feedback(status);

-- 2. Analytics daily snapshots
CREATE TABLE IF NOT EXISTS analytics_daily (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  date date NOT NULL UNIQUE,
  signups integer DEFAULT 0,
  active_users integer DEFAULT 0,
  page_views integer DEFAULT 0,
  trader_page_views integer DEFAULT 0,
  new_claims integer DEFAULT 0,
  new_follows integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE analytics_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service manage analytics_daily" ON analytics_daily FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX idx_analytics_daily_date ON analytics_daily(date DESC);

-- 3. UTM tracking on user registration
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS utm_source text;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS utm_medium text;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS utm_campaign text;

-- 4. User preferences (notification settings, watched traders)
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  watched_traders jsonb DEFAULT '[]'::jsonb,
  email_notifications boolean DEFAULT true,
  push_notifications boolean DEFAULT false,
  ranking_change_threshold integer DEFAULT 10,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own preferences" ON user_preferences FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own preferences" ON user_preferences FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can insert own preferences" ON user_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Service manage user_preferences" ON user_preferences FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5. Notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('ranking_change', 'system', 'claim', 'follow')),
  title text NOT NULL,
  body text,
  data jsonb DEFAULT '{}'::jsonb,
  read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own notifications" ON notifications FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own notifications" ON notifications FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Service manage notifications" ON notifications FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX idx_notifications_user_unread ON notifications(user_id, read) WHERE read = false;
CREATE INDEX idx_notifications_created ON notifications(created_at DESC);
