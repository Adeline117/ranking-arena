-- UF20: Reading progress sync table
CREATE TABLE IF NOT EXISTS reading_progress (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL,
  current_page INT NOT NULL DEFAULT 1,
  total_pages INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, book_id)
);

-- RLS
ALTER TABLE reading_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own progress" ON reading_progress
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can upsert own progress" ON reading_progress
  FOR ALL USING (auth.uid() = user_id);
