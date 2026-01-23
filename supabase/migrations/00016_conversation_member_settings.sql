-- Migration: Add conversation_members table for private chat settings
-- Supports: remark/nickname, mute, pin, block, clear history per user

-- Create conversation_members table
CREATE TABLE IF NOT EXISTS conversation_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  remark TEXT DEFAULT NULL,
  is_muted BOOLEAN NOT NULL DEFAULT false,
  is_pinned BOOLEAN NOT NULL DEFAULT false,
  is_blocked BOOLEAN NOT NULL DEFAULT false,
  cleared_before TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_members_unique UNIQUE (conversation_id, user_id)
);

-- Index for fast lookups by user
CREATE INDEX IF NOT EXISTS idx_conversation_members_user_id
  ON conversation_members(user_id);

-- Index for pinned conversations (used in sorting)
CREATE INDEX IF NOT EXISTS idx_conversation_members_pinned
  ON conversation_members(user_id, is_pinned)
  WHERE is_pinned = true;

-- Index for muted conversations
CREATE INDEX IF NOT EXISTS idx_conversation_members_muted
  ON conversation_members(user_id, is_muted)
  WHERE is_muted = true;

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_conversation_members_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_conversation_members_updated_at
  BEFORE UPDATE ON conversation_members
  FOR EACH ROW
  EXECUTE FUNCTION update_conversation_members_updated_at();

-- RLS policies for conversation_members
ALTER TABLE conversation_members ENABLE ROW LEVEL SECURITY;

-- Users can only view their own membership settings
CREATE POLICY conversation_members_select_policy
  ON conversation_members
  FOR SELECT
  USING (auth.uid() = user_id);

-- Users can only insert their own membership settings
CREATE POLICY conversation_members_insert_policy
  ON conversation_members
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can only update their own membership settings
CREATE POLICY conversation_members_update_policy
  ON conversation_members
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Users can only delete their own membership settings
CREATE POLICY conversation_members_delete_policy
  ON conversation_members
  FOR DELETE
  USING (auth.uid() = user_id);

-- Full-text search index on direct_messages content for message search
CREATE INDEX IF NOT EXISTS idx_direct_messages_content_trgm
  ON direct_messages USING gin (content gin_trgm_ops);

-- Enable pg_trgm extension if not already enabled (for ILIKE search performance)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
