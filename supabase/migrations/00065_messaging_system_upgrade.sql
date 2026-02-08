-- Migration: Complete messaging system upgrade
-- Features: read receipts, online presence, group channels, enhanced search

-- 1. Read Receipts: Add read_at timestamp to direct_messages
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS read_at timestamptz DEFAULT NULL;

-- Backfill: set read_at for already-read messages
UPDATE direct_messages SET read_at = created_at WHERE read = true AND read_at IS NULL;

-- Index for efficient unread queries
CREATE INDEX IF NOT EXISTS idx_direct_messages_unread 
  ON direct_messages (receiver_id, read) WHERE read = false;

-- 2. Online Presence: Add last_seen_at to user_profiles
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS last_seen_at timestamptz DEFAULT NULL;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS is_online boolean DEFAULT false;

-- Index for presence queries
CREATE INDEX IF NOT EXISTS idx_user_profiles_online ON user_profiles (is_online) WHERE is_online = true;

-- 3. Group Channels
CREATE TABLE IF NOT EXISTS chat_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  type text NOT NULL DEFAULT 'direct' CHECK (type IN ('direct', 'group')),
  created_by uuid REFERENCES auth.users(id),
  avatar_url text,
  description text,
  conversation_id uuid REFERENCES conversations(id), -- link to existing conversation for direct chats
  last_message_at timestamptz DEFAULT now(),
  last_message_preview text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  nickname text,
  is_muted boolean DEFAULT false,
  is_pinned boolean DEFAULT false,
  cleared_before timestamptz,
  joined_at timestamptz DEFAULT now(),
  UNIQUE(channel_id, user_id)
);

-- Channel messages table (for group chats)
CREATE TABLE IF NOT EXISTS channel_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id),
  content text NOT NULL DEFAULT '',
  media_url text,
  media_type text CHECK (media_type IN ('image', 'video', 'file')),
  media_name text,
  created_at timestamptz DEFAULT now()
);

-- Channel message read tracking
CREATE TABLE IF NOT EXISTS channel_message_reads (
  channel_id uuid NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  last_read_at timestamptz DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);

-- Indexes for channel queries
CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id);
CREATE INDEX IF NOT EXISTS idx_channel_members_channel ON channel_members(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_messages_sender ON channel_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_chat_channels_type ON chat_channels(type);

-- 4. Full-text search index for messages
CREATE INDEX IF NOT EXISTS idx_direct_messages_content_trgm 
  ON direct_messages USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_channel_messages_content_trgm 
  ON channel_messages USING gin (content gin_trgm_ops);

-- 5. Function to update channel last_message
CREATE OR REPLACE FUNCTION update_channel_last_message()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE chat_channels 
  SET last_message_at = NEW.created_at,
      last_message_preview = LEFT(NEW.content, 100),
      updated_at = now()
  WHERE id = NEW.channel_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_channel_message_update ON channel_messages;
CREATE TRIGGER trg_channel_message_update
  AFTER INSERT ON channel_messages
  FOR EACH ROW EXECUTE FUNCTION update_channel_last_message();

-- 6. Enable RLS on new tables
ALTER TABLE chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_message_reads ENABLE ROW LEVEL SECURITY;

-- RLS policies for chat_channels
CREATE POLICY "Users can view channels they are members of" ON chat_channels
  FOR SELECT USING (
    id IN (SELECT channel_id FROM channel_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can create channels" ON chat_channels
  FOR INSERT WITH CHECK (created_by = auth.uid());

CREATE POLICY "Channel owners can update" ON chat_channels
  FOR UPDATE USING (
    id IN (SELECT channel_id FROM channel_members WHERE user_id = auth.uid() AND role IN ('owner', 'admin'))
  );

-- RLS policies for channel_members
CREATE POLICY "Members can view channel members" ON channel_members
  FOR SELECT USING (
    channel_id IN (SELECT channel_id FROM channel_members cm WHERE cm.user_id = auth.uid())
  );

CREATE POLICY "Channel admins can manage members" ON channel_members
  FOR ALL USING (
    channel_id IN (SELECT channel_id FROM channel_members cm WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin'))
  );

-- RLS policies for channel_messages
CREATE POLICY "Members can view channel messages" ON channel_messages
  FOR SELECT USING (
    channel_id IN (SELECT channel_id FROM channel_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Members can send messages" ON channel_messages
  FOR INSERT WITH CHECK (
    sender_id = auth.uid() AND
    channel_id IN (SELECT channel_id FROM channel_members WHERE user_id = auth.uid())
  );

-- RLS for channel_message_reads
CREATE POLICY "Users can manage own read status" ON channel_message_reads
  FOR ALL USING (user_id = auth.uid());
