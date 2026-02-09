-- Book review system: add category and book_id to posts for long reviews
ALTER TABLE posts ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS book_id UUID REFERENCES library_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category);
CREATE INDEX IF NOT EXISTS idx_posts_book_id ON posts(book_id) WHERE book_id IS NOT NULL;
