-- Unified ratings for institutions and tools directories
CREATE TABLE IF NOT EXISTS directory_ratings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('institution', 'tool')),
  item_id UUID NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, item_type, item_id)
);

CREATE INDEX idx_dir_ratings_item ON directory_ratings(item_type, item_id);
CREATE INDEX idx_dir_ratings_user ON directory_ratings(user_id);

-- RLS
ALTER TABLE directory_ratings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read ratings" ON directory_ratings FOR SELECT USING (true);
CREATE POLICY "Auth users can insert ratings" ON directory_ratings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own ratings" ON directory_ratings FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own ratings" ON directory_ratings FOR DELETE USING (auth.uid() = user_id);

-- Function to update avg_rating on institutions/tools after rating change
CREATE OR REPLACE FUNCTION update_directory_avg_rating()
RETURNS TRIGGER AS $$
DECLARE
  avg_val NUMERIC;
  cnt INTEGER;
  target_table TEXT;
  target_id UUID;
BEGIN
  -- Determine which table to update
  target_table := COALESCE(NEW.item_type, OLD.item_type);
  target_id := COALESCE(NEW.item_id, OLD.item_id);

  SELECT AVG(rating)::NUMERIC(3,2), COUNT(*)
  INTO avg_val, cnt
  FROM directory_ratings
  WHERE item_type = target_table
    AND item_id = target_id;

  IF target_table = 'institution' THEN
    UPDATE institutions SET avg_rating = COALESCE(avg_val, 0), rating_count = cnt
    WHERE id = target_id;
  ELSIF target_table = 'tool' THEN
    UPDATE tools SET avg_rating = COALESCE(avg_val, 0), rating_count = cnt
    WHERE id = target_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_update_dir_avg_rating
AFTER INSERT OR UPDATE OR DELETE ON directory_ratings
FOR EACH ROW EXECUTE FUNCTION update_directory_avg_rating();
