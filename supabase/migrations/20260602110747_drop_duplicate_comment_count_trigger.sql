-- D-7: Drop trigger-based comment_count increment.
-- The API routes already call atomic RPCs (increment_comment_count /
-- decrement_comment_count from migration 00021). The trigger causes
-- double-counting: trigger +1, then RPC +1 = count inflated by 2x.
--
-- After this migration, only the RPC path updates comment_count.

DROP TRIGGER IF EXISTS on_comment_change ON comments;

-- Fix any existing double-counted posts by recalculating from actual rows.
UPDATE posts p
SET comment_count = sub.actual_count
FROM (
  SELECT post_id, COUNT(*) AS actual_count
  FROM comments
  GROUP BY post_id
) sub
WHERE p.id = sub.post_id
  AND p.comment_count != sub.actual_count;
