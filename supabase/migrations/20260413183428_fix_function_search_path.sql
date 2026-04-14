-- Migration: 20260413183428_fix_function_search_path.sql
-- Created: 2026-04-14T01:34:28Z
-- Fix mutable search_path on 42 public functions
-- Security: prevents search_path manipulation attacks
-- Ref: https://supabase.com/docs/guides/database/database-linter?lint=0010_function_search_path_mutable

ALTER FUNCTION public.migrate_position_history_batch SET search_path = public, pg_temp;
ALTER FUNCTION public.create_next_tph_partition SET search_path = public, pg_temp;
ALTER FUNCTION public.claimant_counts SET search_path = public, pg_temp;
ALTER FUNCTION public.bulk_update_snapshot_metrics SET search_path = public, pg_temp;
ALTER FUNCTION public.count_distinct_projects SET search_path = public, pg_temp;
ALTER FUNCTION public.project_stats SET search_path = public, pg_temp;
ALTER FUNCTION public.sanitize_daily_snapshot_on_write SET search_path = public, pg_temp;
ALTER FUNCTION public.trunc_as_of_ts_to_hour SET search_path = public, pg_temp;
ALTER FUNCTION public.calculate_arena_score SET search_path = public, pg_temp;
ALTER FUNCTION public.calculate_hot_score SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_all_data_violations SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_old_pipeline_logs SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_old_stripe_events SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_snapshot_violations SET search_path = public, pg_temp;
ALTER FUNCTION public.count_trader_followers SET search_path = public, pg_temp;
ALTER FUNCTION public.db_stats SET search_path = public, pg_temp;
ALTER FUNCTION public.create_monthly_partition SET search_path = public, pg_temp;
ALTER FUNCTION public.ensure_future_partitions SET search_path = public, pg_temp;
ALTER FUNCTION public.fill_null_pnl_from_siblings SET search_path = public, pg_temp;
ALTER FUNCTION public.fix_snapshot_violations SET search_path = public, pg_temp;
ALTER FUNCTION public.get_latest_funding_rates SET search_path = public, pg_temp;
ALTER FUNCTION public.get_diverse_leaderboard SET search_path = public, pg_temp;
ALTER FUNCTION public.get_latest_open_interest SET search_path = public, pg_temp;
ALTER FUNCTION public.get_latest_prev_snapshots SET search_path = public, pg_temp;
ALTER FUNCTION public.get_latest_snapshots_for_date SET search_path = public, pg_temp;
ALTER FUNCTION public.get_latest_timestamps_by_source SET search_path = public, pg_temp;
ALTER FUNCTION public.get_leaderboard_latest_by_source SET search_path = public, pg_temp;
ALTER FUNCTION public.get_library_category_counts SET search_path = public, pg_temp;
ALTER FUNCTION public.get_pipeline_job_stats_recent SET search_path = public, pg_temp;
ALTER FUNCTION public.get_pipeline_job_statuses_recent SET search_path = public, pg_temp;
ALTER FUNCTION public.get_platform_stats SET search_path = public, pg_temp;
ALTER FUNCTION public.recommend_groups_for_user SET search_path = public, pg_temp;
ALTER FUNCTION public.refresh_leaderboard_count_cache SET search_path = public, pg_temp;
ALTER FUNCTION public.sanitize_equity_curve_on_write SET search_path = public, pg_temp;
ALTER FUNCTION public.sanitize_snapshot_on_write SET search_path = public, pg_temp;
ALTER FUNCTION public.scan_data_quality_anomalies SET search_path = public, pg_temp;
ALTER FUNCTION public.search_did_you_mean SET search_path = public, pg_temp;
ALTER FUNCTION public.search_traders_fuzzy SET search_path = public, pg_temp;
ALTER FUNCTION public.set_snapshot_date SET search_path = public, pg_temp;
ALTER FUNCTION public.update_directory_avg_rating SET search_path = public, pg_temp;
ALTER FUNCTION public.update_updated_at_column SET search_path = public, pg_temp;
ALTER FUNCTION public.wilson_score_lower SET search_path = public, pg_temp;
