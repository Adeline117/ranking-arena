-- RPC function: count followers per trader using GROUP BY
-- Returns one row per trader with their follower count (instead of fetching all rows)

CREATE OR REPLACE FUNCTION count_trader_followers(trader_ids text[])
RETURNS TABLE(trader_id text, cnt bigint) AS $$
BEGIN
  RETURN QUERY
    SELECT tf.trader_id, COUNT(*)::bigint AS cnt
    FROM trader_follows tf
    WHERE tf.trader_id = ANY(trader_ids)
    GROUP BY tf.trader_id;
END;
$$ LANGUAGE plpgsql STABLE;
