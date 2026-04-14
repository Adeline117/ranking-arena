-- Migration: drop_duplicate_unused_indexes
-- Purpose: Drop verified duplicate and unused indexes to reclaim ~2.7 GB disk
-- Verified via pg_stat_user_indexes (idx_scan=0) and pg_indexes (identical definitions)
-- Applied live via execute_sql before this migration file was created

-- ============================================================
-- Parent partitioned indexes (cascade to all partition children)
-- ============================================================

-- Duplicate of idx_snapshots_v2_part_window_score (identical definition)
DROP INDEX IF EXISTS idx_snapshots_v2_window_arena_score;

-- Filtered subset with hardcoded date, idx_scan=0 across all partitions
DROP INDEX IF EXISTS idx_snapshots_v2_window_score_recent;

-- Simple btree covered by the INCLUDE index, idx_scan=0
DROP INDEX IF EXISTS idx_snapshots_v2_part_window_score;

-- ============================================================
-- Small table duplicate indexes (keep constraint, drop redundant idx)
-- ============================================================

DROP INDEX IF EXISTS idx_daily_snapshots_trader_date;
DROP INDEX IF EXISTS idx_pipeline_logs_job_name_pattern;
DROP INDEX IF EXISTS idx_pipeline_logs_job_started;
DROP INDEX IF EXISTS idx_rank_history_trader_period;
DROP INDEX IF EXISTS idx_profiles_v2_platform_trader;
DROP INDEX IF EXISTS traders_source_stid_uniq;
DROP INDEX IF EXISTS idx_open_interest_platform_symbol;
DROP INDEX IF EXISTS idx_flash_news_published_at;
DROP INDEX IF EXISTS idx_translation_cache_lookup;
DROP INDEX IF EXISTS idx_funding_rates_platform_symbol;
DROP INDEX IF EXISTS idx_bot_sources_slug;
DROP INDEX IF EXISTS idx_position_summary_platform_trader;
DROP INDEX IF EXISTS idx_direct_messages_conversation_created;
DROP INDEX IF EXISTS idx_direct_messages_unread;
DROP INDEX IF EXISTS idx_analytics_daily_date;
DROP INDEX IF EXISTS idx_market_conditions_symbol_date;
DROP INDEX IF EXISTS idx_market_benchmarks_symbol_date;
DROP INDEX IF EXISTS idx_notifications_unread_count;
DROP INDEX IF EXISTS idx_ult_trader;
DROP INDEX IF EXISTS idx_uec_user_exchange_active;
DROP INDEX IF EXISTS idx_ranking_snapshots_share_token;
DROP INDEX IF EXISTS idx_trader_links_trader_source;
DROP INDEX IF EXISTS idx_trader_scores_lookup;
DROP INDEX IF EXISTS idx_liquidation_stats_platform_symbol;
DROP INDEX IF EXISTS idx_trader_claims_trader;
DROP INDEX IF EXISTS idx_verified_traders_trader;
DROP INDEX IF EXISTS idx_pipeline_state_key_prefix;
DROP INDEX IF EXISTS idx_refresh_jobs_pending;

-- ============================================================
-- Unused indexes on core tables (idx_scan=0, not PKs needed for integrity)
-- ============================================================

DROP INDEX IF EXISTS idx_trader_snapshots_captured;
DROP INDEX IF EXISTS idx_traders_active_refresh;
DROP INDEX IF EXISTS idx_traders_active_platform_updated;
DROP INDEX IF EXISTS idx_ts_season_source_arena_score;
DROP INDEX IF EXISTS idx_trader_snapshots_source_trader;
DROP INDEX IF EXISTS idx_pipeline_logs_job_status_started;
DROP INDEX IF EXISTS idx_pipeline_logs_running;
