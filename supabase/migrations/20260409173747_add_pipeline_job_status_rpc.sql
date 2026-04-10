-- Migration: 20260409173747_add_pipeline_job_status_rpc
-- Created: 2026-04-10T00:37:47Z
-- Description: RPC functions to replace pipeline_job_status / pipeline_job_stats views.
--
-- Root cause: the old views used DISTINCT ON / GROUP BY over the entire
-- pipeline_logs table (44k rows). Under cron contention they consistently hit
-- Postgres statement_timeout (>30s). The PostgREST default 1000-row cap also
-- prevented the application from paginating around the issue with larger
-- direct queries.
--
-- These RPCs do server-side aggregation with explicit time bounds and return
-- already-grouped results, bypassing both the DISTINCT ON cost and the
-- PostgREST row cap. Both functions are STABLE and safe to call from
-- /api/health/pipeline.

-- Up

-- ----------------------------------------------------------------------------
-- get_pipeline_job_statuses_recent()
-- Returns the latest row per job_name within the last 24h, with derived
-- health_status. Replaces the pipeline_job_status view.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_pipeline_job_statuses_recent()
RETURNS TABLE (
  job_name text,
  started_at timestamptz,
  status text,
  records_processed bigint,
  error_message text,
  health_status text
)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (job_name)
    job_name,
    started_at,
    status,
    COALESCE(records_processed, 0)::bigint as records_processed,
    error_message,
    CASE
      WHEN status = 'running' AND started_at < now() - interval '30 minutes' THEN 'stuck'
      WHEN status = 'error' OR status = 'timeout' THEN 'failed'
      WHEN status = 'success' AND started_at < now() - interval '24 hours' THEN 'stale'
      WHEN status = 'success' THEN 'healthy'
      ELSE status
    END AS health_status
  FROM pipeline_logs
  WHERE started_at > now() - interval '24 hours'
  ORDER BY job_name, started_at DESC;
$$;

-- ----------------------------------------------------------------------------
-- get_pipeline_job_stats_recent()
-- Returns 7-day aggregates per job_name. Replaces the pipeline_job_stats view.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_pipeline_job_stats_recent()
RETURNS TABLE (
  job_name text,
  total_runs bigint,
  success_count bigint,
  error_count bigint,
  success_rate numeric,
  avg_duration_ms numeric,
  last_run_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    job_name,
    COUNT(*)::bigint as total_runs,
    COUNT(*) FILTER (WHERE status = 'success')::bigint as success_count,
    COUNT(*) FILTER (WHERE status IN ('error', 'timeout'))::bigint as error_count,
    ROUND(
      COUNT(*) FILTER (WHERE status = 'success')::numeric / NULLIF(COUNT(*), 0) * 100,
      1
    ) as success_rate,
    AVG(duration_ms) FILTER (WHERE status = 'success') as avg_duration_ms,
    MAX(started_at) as last_run_at
  FROM pipeline_logs
  WHERE started_at > now() - interval '7 days'
  GROUP BY job_name;
$$;

-- Grant execute
GRANT EXECUTE ON FUNCTION get_pipeline_job_statuses_recent() TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION get_pipeline_job_stats_recent() TO authenticated, service_role, anon;
