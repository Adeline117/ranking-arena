-- Add avatar_url column to trader_sources table
-- This column stores the actual avatar image URL (different from profile_url which stores the trader's profile page URL)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trader_sources' AND column_name = 'avatar_url'
  ) THEN
    ALTER TABLE trader_sources ADD COLUMN avatar_url TEXT;

    -- Create index for faster queries
    CREATE INDEX IF NOT EXISTS idx_trader_sources_avatar_url ON trader_sources(avatar_url) WHERE avatar_url IS NOT NULL;

    COMMENT ON COLUMN trader_sources.avatar_url IS 'Avatar image URL (direct image link)';
    COMMENT ON COLUMN trader_sources.profile_url IS 'Trader profile page URL';
  END IF;
END $$;
