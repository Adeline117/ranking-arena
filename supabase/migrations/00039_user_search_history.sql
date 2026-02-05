-- Add search history to user_profiles
-- Stores recent search queries for logged-in users

-- Add search_history column as JSONB array
ALTER TABLE user_profiles
ADD COLUMN IF NOT EXISTS search_history JSONB DEFAULT '[]'::jsonb;

-- Add index for efficient search history queries
CREATE INDEX IF NOT EXISTS idx_user_profiles_search_history
ON user_profiles USING GIN (search_history);

-- Comment for documentation
COMMENT ON COLUMN user_profiles.search_history IS 'Array of {query: string, timestamp: number} objects representing recent searches';
