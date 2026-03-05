-- Add show_pro_badge column to user_profiles
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS show_pro_badge boolean DEFAULT true;
