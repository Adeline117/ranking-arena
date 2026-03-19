-- Migration: Drop unused materialized views
-- Date: 2026-03-19
-- Purpose: Remove MVs that are no longer referenced by any application code
-- Verified: grep across all .ts/.tsx/.js/.jsx files found zero references

-- Drop refresh functions first
DROP FUNCTION IF EXISTS refresh_materialized_views();
DROP FUNCTION IF EXISTS refresh_mv_leaderboard();
DROP FUNCTION IF EXISTS refresh_mv_hot_posts();

-- Drop the materialized views
DROP MATERIALIZED VIEW IF EXISTS mv_leaderboard;
DROP MATERIALIZED VIEW IF EXISTS mv_hot_posts;
DROP MATERIALIZED VIEW IF EXISTS mv_hourly_prices;
DROP MATERIALIZED VIEW IF EXISTS mv_daily_rankings;
