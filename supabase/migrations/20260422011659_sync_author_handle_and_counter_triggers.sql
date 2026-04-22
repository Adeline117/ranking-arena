-- Migration: 20260422011659_sync_author_handle_and_counter_triggers.sql
-- Created: 2026-04-22
-- Description: Fix M-9 (stale author_handle) and M-10 (fire-and-forget counters)

-- ============================================================
-- M-9: Sync author_handle when user changes their handle
-- ============================================================

CREATE OR REPLACE FUNCTION sync_author_handle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only fire when handle actually changes
  IF OLD.handle IS DISTINCT FROM NEW.handle THEN
    UPDATE posts SET author_handle = NEW.handle WHERE author_id = NEW.id;
    UPDATE comments SET author_handle = NEW.handle WHERE author_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_author_handle ON user_profiles;
CREATE TRIGGER trg_sync_author_handle
  AFTER UPDATE OF handle ON user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION sync_author_handle();

-- ============================================================
-- M-10: Replace fire-and-forget group member_count with DB trigger
-- ============================================================

CREATE OR REPLACE FUNCTION update_group_member_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE groups SET member_count = member_count + 1 WHERE id = NEW.group_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE groups SET member_count = GREATEST(member_count - 1, 0) WHERE id = OLD.group_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_group_member_count ON group_members;
CREATE TRIGGER trg_update_group_member_count
  AFTER INSERT OR DELETE ON group_members
  FOR EACH ROW
  EXECUTE FUNCTION update_group_member_count();
