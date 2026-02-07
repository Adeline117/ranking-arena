ALTER TABLE library_items ADD COLUMN IF NOT EXISTS language_group_id UUID;
CREATE INDEX IF NOT EXISTS idx_library_language_group ON library_items(language_group_id);
