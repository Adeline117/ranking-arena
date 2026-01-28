-- Add media support to direct_messages table
-- This allows users to send images, videos, and files in chat

-- Add media columns if they don't exist
DO $$
BEGIN
    -- Add media_url column
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'direct_messages' AND column_name = 'media_url'
    ) THEN
        ALTER TABLE direct_messages ADD COLUMN media_url TEXT;
    END IF;

    -- Add media_type column (image, video, file)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'direct_messages' AND column_name = 'media_type'
    ) THEN
        ALTER TABLE direct_messages ADD COLUMN media_type TEXT;
    END IF;

    -- Add media_name column (original filename for files)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'direct_messages' AND column_name = 'media_name'
    ) THEN
        ALTER TABLE direct_messages ADD COLUMN media_name TEXT;
    END IF;
END $$;

-- Add check constraint for media_type
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'direct_messages_media_type_check'
    ) THEN
        ALTER TABLE direct_messages
        ADD CONSTRAINT direct_messages_media_type_check
        CHECK (media_type IS NULL OR media_type IN ('image', 'video', 'file'));
    END IF;
END $$;

-- Create chat storage bucket if it doesn't exist
-- Note: This is handled by the API, but we document it here for reference
COMMENT ON COLUMN direct_messages.media_url IS 'URL to the uploaded media file in Supabase Storage (chat bucket)';
COMMENT ON COLUMN direct_messages.media_type IS 'Type of media: image, video, or file';
COMMENT ON COLUMN direct_messages.media_name IS 'Original filename for file attachments';
