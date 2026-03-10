-- Add bio_source column to trader_profiles_v2
-- Tracks origin of bio text: 'auto' (generated), 'manual' (user-written), 'exchange' (from API)
-- This prevents auto-generated bios from overwriting manual ones.

ALTER TABLE trader_profiles_v2
  ADD COLUMN IF NOT EXISTS bio_source TEXT DEFAULT NULL;

-- Add check constraint for valid values
ALTER TABLE trader_profiles_v2
  ADD CONSTRAINT chk_bio_source CHECK (bio_source IN ('auto', 'manual', 'exchange') OR bio_source IS NULL);

-- Index for efficient querying of profiles needing auto-generation
CREATE INDEX IF NOT EXISTS idx_trader_profiles_v2_bio_source
  ON trader_profiles_v2 (bio_source)
  WHERE bio IS NULL OR bio_source IS NULL;

COMMENT ON COLUMN trader_profiles_v2.bio_source IS 'Source of bio: auto=generated, manual=user-written, exchange=from API';
