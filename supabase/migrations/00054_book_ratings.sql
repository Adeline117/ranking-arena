CREATE TABLE IF NOT EXISTS book_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  library_item_id UUID NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, library_item_id)
);

CREATE INDEX idx_book_ratings_item ON book_ratings(library_item_id);
CREATE INDEX idx_book_ratings_user ON book_ratings(user_id);

-- Update library_items rating when a new rating is added
CREATE OR REPLACE FUNCTION update_book_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE library_items SET 
    rating = (SELECT AVG(rating)::NUMERIC(3,2) FROM book_ratings WHERE library_item_id = COALESCE(NEW.library_item_id, OLD.library_item_id)),
    rating_count = (SELECT COUNT(*) FROM book_ratings WHERE library_item_id = COALESCE(NEW.library_item_id, OLD.library_item_id)),
    updated_at = NOW()
  WHERE id = COALESCE(NEW.library_item_id, OLD.library_item_id);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_book_rating
AFTER INSERT OR UPDATE OR DELETE ON book_ratings
FOR EACH ROW EXECUTE FUNCTION update_book_rating();
