-- KOL申请表
CREATE TABLE IF NOT EXISTS kol_applications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  tier TEXT NOT NULL CHECK (tier IN ('tier1', 'tier2', 'tier3')),
  platform TEXT,
  platform_handle TEXT,
  follower_count INTEGER,
  description TEXT,
  proof_url TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer_notes TEXT,
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- KOL认证标识
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS kol_tier TEXT CHECK (kol_tier IN ('tier1', 'tier2', 'tier3'));
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- 内容举报表
CREATE TABLE IF NOT EXISTS content_reports (
  id BIGSERIAL PRIMARY KEY,
  reporter_id UUID REFERENCES auth.users(id),
  content_type TEXT NOT NULL CHECK (content_type IN ('post', 'comment', 'profile')),
  content_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('spam', 'scam', 'harassment', 'misinformation', 'nsfw', 'other')),
  description TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'actioned', 'dismissed')),
  reviewer_id UUID,
  action_taken TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 用户信用分
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS credit_score INTEGER DEFAULT 100;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT false;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS ban_expires_at TIMESTAMPTZ;

-- RLS policies
ALTER TABLE kol_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_reports ENABLE ROW LEVEL SECURITY;

-- KOL applications: users can insert their own, admins can read all
CREATE POLICY "users_insert_own_kol_app" ON kol_applications FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_read_own_kol_app" ON kol_applications FOR SELECT USING (auth.uid() = user_id);

-- Content reports: users can insert, admins manage via service role
CREATE POLICY "users_insert_reports" ON content_reports FOR INSERT WITH CHECK (auth.uid() = reporter_id);
CREATE POLICY "users_read_own_reports" ON content_reports FOR SELECT USING (auth.uid() = reporter_id);
