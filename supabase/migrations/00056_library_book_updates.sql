-- Add status column for want_to_read / read
ALTER TABLE book_ratings ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'read' CHECK (status IN ('want_to_read', 'read'));

-- Allow rating to be null for want_to_read
ALTER TABLE book_ratings ALTER COLUMN rating DROP NOT NULL;

-- Update constraint: want_to_read allows null rating, read requires 1-5
ALTER TABLE book_ratings DROP CONSTRAINT IF EXISTS book_ratings_rating_check;
ALTER TABLE book_ratings ADD CONSTRAINT book_ratings_rating_check CHECK (
  (status = 'want_to_read' AND rating IS NULL) OR 
  (status = 'read' AND rating >= 1 AND rating <= 5)
);

-- Update the trigger function to only count 'read' ratings
CREATE OR REPLACE FUNCTION update_book_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE library_items SET 
    rating = (SELECT AVG(rating)::NUMERIC(3,2) FROM book_ratings WHERE library_item_id = COALESCE(NEW.library_item_id, OLD.library_item_id) AND status = 'read'),
    rating_count = (SELECT COUNT(*) FROM book_ratings WHERE library_item_id = COALESCE(NEW.library_item_id, OLD.library_item_id) AND status = 'read'),
    updated_at = NOW()
  WHERE id = COALESCE(NEW.library_item_id, OLD.library_item_id);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

ALTER TABLE library_items ADD COLUMN IF NOT EXISTS publisher TEXT;
