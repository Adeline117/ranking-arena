-- Partial index for pipeline freshness queries:
-- SELECT ended_at FROM pipeline_logs WHERE status = 'success' ORDER BY ended_at DESC
-- Used by /api/rankings and compute-leaderboard to check data freshness.
-- Without this, the query seq-scans pipeline_logs (grows unbounded).

CREATE INDEX IF NOT EXISTS idx_pipeline_logs_freshness
  ON pipeline_logs (status, ended_at DESC)
  WHERE status = 'success';
