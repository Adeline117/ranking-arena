-- Reading statistics: track time spent, pages read, reading speed
CREATE TABLE IF NOT EXISTS reading_statistics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL,
  total_reading_time_sec INT NOT NULL DEFAULT 0,
  pages_read INT NOT NULL DEFAULT 0,
  sessions_count INT NOT NULL DEFAULT 0,
  last_session_start TIMESTAMPTZ,
  last_session_duration_sec INT DEFAULT 0,
  avg_speed_chars_per_min REAL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, book_id)
);

-- Add epub_cfi column to reading_progress for epub position sync
ALTER TABLE reading_progress ADD COLUMN IF NOT EXISTS epub_cfi TEXT;
ALTER TABLE reading_progress ADD COLUMN IF NOT EXISTS progress_percent REAL DEFAULT 0;

-- RLS
ALTER TABLE reading_statistics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own stats" ON reading_statistics
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can upsert own stats" ON reading_statistics
  FOR ALL USING (auth.uid() = user_id);
