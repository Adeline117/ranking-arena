-- Index for RLS policy subquery performance on group_members
-- Posts visibility RLS policy does:
--   EXISTS (SELECT 1 FROM group_members WHERE group_id = posts.group_id AND user_id = auth.uid())
-- Without this index, it's a sequential scan per-row on every posts SELECT.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_members_group_user
  ON group_members (group_id, user_id);
