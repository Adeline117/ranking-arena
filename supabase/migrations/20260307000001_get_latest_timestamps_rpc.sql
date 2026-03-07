-- RPC function to get latest captured_at per source in a single query
-- Replaces 35+ parallel queries in getAllLatestTimestamps
CREATE OR REPLACE FUNCTION get_latest_timestamps_by_source(p_season_id text DEFAULT '90D')
RETURNS TABLE(source text, captured_at timestamptz) AS $$
  SELECT DISTINCT ON (source) source, captured_at
  FROM trader_snapshots
  WHERE season_id = p_season_id
  ORDER BY source, captured_at DESC;
$$ LANGUAGE sql STABLE;
