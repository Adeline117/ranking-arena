-- Migration: 20260422011511_add_cascade_and_unique_constraints.sql
-- Created: 2026-04-22
-- Fix H-4: Add ON DELETE CASCADE to orphan-prone FK references
-- Fix M-8: Add UNIQUE constraint on group_members to prevent duplicate membership

-- H-4a: user_levels.user_id → auth.users(id) ON DELETE CASCADE
ALTER TABLE user_levels DROP CONSTRAINT IF EXISTS user_levels_user_id_fkey;
ALTER TABLE user_levels ADD CONSTRAINT user_levels_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- H-4b: exp_transactions.user_id → auth.users(id) ON DELETE CASCADE
ALTER TABLE exp_transactions DROP CONSTRAINT IF EXISTS exp_transactions_user_id_fkey;
ALTER TABLE exp_transactions ADD CONSTRAINT exp_transactions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- M-8: UNIQUE constraint on group_members(group_id, user_id)
-- There is already a btree index on (group_id, user_id) from migration
-- 20260403d_idx_group_members_rls; adding a UNIQUE constraint will replace
-- it with a unique index that also enforces the constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'group_members_group_user_unique'
  ) THEN
    ALTER TABLE group_members ADD CONSTRAINT group_members_group_user_unique
      UNIQUE (group_id, user_id);
  END IF;
END $$;
