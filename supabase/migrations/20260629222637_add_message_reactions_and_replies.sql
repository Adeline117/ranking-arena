-- Migration: 20260629222637_add_message_reactions_and_replies.sql
-- Created: 2026-06-30T05:26:37Z
-- Description: DM + group-chat emoji reactions and reply/quote.
--   * message_reactions / channel_message_reactions: mirror post_emoji_reactions
--     (aggregate-on-read, no counter column → no atomic RPC needed), BUT RLS SELECT
--     is scoped to conversation/channel members (DMs are private — never USING(true)).
--   * reply_to_id on direct_messages / channel_messages (ON DELETE SET NULL so
--     deleting the quoted message doesn't nuke the reply).

-- ===== 1:1 DM reactions =====
CREATE TABLE IF NOT EXISTS message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 10),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_user ON message_reactions(user_id);

ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;

-- SELECT: only the two participants of the parent message's DM (private).
CREATE POLICY "Participants can read DM reactions"
  ON message_reactions FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM direct_messages dm
      WHERE dm.id = message_reactions.message_id
        AND (dm.sender_id = auth.uid() OR dm.receiver_id = auth.uid())
    )
  );

-- INSERT: own row AND must be a participant of the parent message.
CREATE POLICY "Participants can add their own DM reaction"
  ON message_reactions FOR INSERT WITH CHECK (
    auth.uid() = user_id AND EXISTS (
      SELECT 1 FROM direct_messages dm
      WHERE dm.id = message_reactions.message_id
        AND (dm.sender_id = auth.uid() OR dm.receiver_id = auth.uid())
    )
  );

CREATE POLICY "Users can remove their own DM reaction"
  ON message_reactions FOR DELETE USING (auth.uid() = user_id);

-- ===== Group-channel reactions =====
CREATE TABLE IF NOT EXISTS channel_message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 10),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_channel_message_reactions_message ON channel_message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_channel_message_reactions_user ON channel_message_reactions(user_id);

ALTER TABLE channel_message_reactions ENABLE ROW LEVEL SECURITY;

-- SELECT: only members of the channel the parent message belongs to.
CREATE POLICY "Channel members can read reactions"
  ON channel_message_reactions FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM channel_messages cm
      JOIN channel_members mem ON mem.channel_id = cm.channel_id
      WHERE cm.id = channel_message_reactions.message_id
        AND mem.user_id = auth.uid()
    )
  );

CREATE POLICY "Channel members can add their own reaction"
  ON channel_message_reactions FOR INSERT WITH CHECK (
    auth.uid() = user_id AND EXISTS (
      SELECT 1 FROM channel_messages cm
      JOIN channel_members mem ON mem.channel_id = cm.channel_id
      WHERE cm.id = channel_message_reactions.message_id
        AND mem.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can remove their own channel reaction"
  ON channel_message_reactions FOR DELETE USING (auth.uid() = user_id);

-- ===== Reply / quote columns =====
ALTER TABLE direct_messages
  ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES direct_messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_direct_messages_reply_to ON direct_messages(reply_to_id);

ALTER TABLE channel_messages
  ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES channel_messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_channel_messages_reply_to ON channel_messages(reply_to_id);
