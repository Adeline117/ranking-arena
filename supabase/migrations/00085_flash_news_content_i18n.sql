-- Add missing i18n content columns and unique title constraint to flash_news
-- content_zh and content_en are referenced by the UI but were missing from migrations.
-- Unique constraint on title is required for the cron job's upsert(onConflict: 'title').

ALTER TABLE flash_news
  ADD COLUMN IF NOT EXISTS content_zh TEXT,
  ADD COLUMN IF NOT EXISTS content_en TEXT;

-- Add unique constraint on title (required for upsert deduplication in flash-news-fetch cron)
-- Use a partial index to avoid issues with very long titles (limit to 500 chars)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'flash_news_title_unique' AND conrelid = 'flash_news'::regclass
  ) THEN
    ALTER TABLE flash_news ADD CONSTRAINT flash_news_title_unique UNIQUE (title);
  END IF;
END $$;
