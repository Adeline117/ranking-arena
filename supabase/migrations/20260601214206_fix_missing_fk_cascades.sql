-- Migration: 20260601214206_fix_missing_fk_cascades.sql
-- Fix 3 FKs missing ON DELETE CASCADE/SET NULL.
-- Without these, user account deletion (GDPR, bans) is blocked by FK constraints.

-- 1. competition_entries.user_id → CASCADE (remove entries when user deleted)
ALTER TABLE competition_entries
  DROP CONSTRAINT IF EXISTS competition_entries_user_id_fkey;
ALTER TABLE competition_entries
  ADD CONSTRAINT competition_entries_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. kol_applications.user_id → SET NULL (preserve application record for audit)
ALTER TABLE kol_applications
  DROP CONSTRAINT IF EXISTS kol_applications_user_id_fkey;
ALTER TABLE kol_applications
  ADD CONSTRAINT kol_applications_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- 3. user_profiles.referred_by → SET NULL (preserve referral chain, null the deleted referrer)
ALTER TABLE user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_referred_by_fkey;
ALTER TABLE user_profiles
  ADD CONSTRAINT user_profiles_referred_by_fkey
  FOREIGN KEY (referred_by) REFERENCES user_profiles(id) ON DELETE SET NULL;
