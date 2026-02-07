CREATE TABLE IF NOT EXISTS library_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  title_en TEXT,
  title_zh TEXT,
  author TEXT,
  description TEXT,
  category TEXT NOT NULL,
  subcategory TEXT,
  source TEXT,
  source_url TEXT,
  pdf_url TEXT,
  cover_url TEXT,
  file_key TEXT,
  file_size_bytes BIGINT,
  page_count INT,
  language TEXT DEFAULT 'en',
  tags TEXT[],
  crypto_symbols TEXT[],
  publish_date DATE,
  rating NUMERIC(3,2),
  rating_count INT DEFAULT 0,
  view_count INT DEFAULT 0,
  download_count INT DEFAULT 0,
  isbn TEXT,
  doi TEXT,
  is_free BOOLEAN DEFAULT true,
  buy_url TEXT,
  ai_summary TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_library_category ON library_items(category);
CREATE INDEX idx_library_source ON library_items(source);
CREATE INDEX idx_library_tags ON library_items USING gin(tags);
CREATE INDEX idx_library_symbols ON library_items USING gin(crypto_symbols);
CREATE INDEX idx_library_title_search ON library_items USING gin(to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')));
