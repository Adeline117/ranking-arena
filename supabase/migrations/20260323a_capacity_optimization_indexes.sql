-- ══════════════════════════════════════════════════════════════
-- Capacity optimization: indexes + RPC functions (2026-03-23)
-- Fixes: groups/[id] manage sort, posts pinned sort, library popular sort
-- Adds: DB-side dedup for funding-rates, open-interest, library categories
-- ══════════════════════════════════════════════════════════════

-- Index 1: group_members — manage page sort by role + join date
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_members_group_role_joined
  ON group_members (group_id, role, joined_at DESC);

-- Index 2: posts — group page sort by pinned + created
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_group_pinned_created
  ON posts (group_id, is_pinned DESC, created_at DESC);

-- Index 3: library_items — popular sort by view_count
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_library_items_view_count_desc
  ON library_items (view_count DESC);

-- RPC 1: funding_rates DISTINCT ON (replaces client-side 200-row dedup)
CREATE OR REPLACE FUNCTION get_latest_funding_rates()
RETURNS TABLE(platform text, symbol text, funding_rate numeric, funding_time timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (platform, symbol)
    platform, symbol, funding_rate, funding_time
  FROM funding_rates
  ORDER BY platform, symbol, funding_time DESC;
$$;

-- RPC 2: open_interest DISTINCT ON (replaces client-side 200-row dedup)
CREATE OR REPLACE FUNCTION get_latest_open_interest()
RETURNS TABLE(platform text, symbol text, open_interest_usd numeric, open_interest_contracts numeric, "timestamp" timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (platform, symbol)
    platform, symbol, open_interest_usd, open_interest_contracts, timestamp
  FROM open_interest
  ORDER BY platform, symbol, timestamp DESC;
$$;

-- RPC 3: library category counts (replaces full-table 60k+ row scan)
CREATE OR REPLACE FUNCTION get_library_category_counts()
RETURNS TABLE(category text, count bigint)
LANGUAGE sql STABLE AS $$
  SELECT category, COUNT(*) as count
  FROM library_items
  WHERE category IS NOT NULL
  GROUP BY category
  ORDER BY count DESC;
$$;
