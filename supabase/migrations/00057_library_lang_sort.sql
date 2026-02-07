-- Sort library items with preferred language first
CREATE OR REPLACE FUNCTION library_items_by_lang(
  p_category TEXT DEFAULT NULL,
  p_preferred_lang TEXT DEFAULT 'en',
  p_limit INT DEFAULT 24,
  p_offset INT DEFAULT 0
)
RETURNS SETOF library_items AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM library_items
  WHERE (p_category IS NULL OR category = p_category)
  ORDER BY
    CASE WHEN language = p_preferred_lang THEN 0 ELSE 1 END,
    view_count DESC NULLS LAST,
    rating DESC NULLS LAST
  LIMIT p_limit OFFSET p_offset;
END;
$$ LANGUAGE plpgsql STABLE;
