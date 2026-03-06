-- Pipeline execution logs for monitoring cron job health
-- Each cron job execution records: start, end, status, records processed, errors

CREATE TABLE IF NOT EXISTS pipeline_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_name text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'error', 'timeout')),
  records_processed integer DEFAULT 0,
  error_message text,
  metadata jsonb DEFAULT '{}',
  duration_ms integer GENERATED ALWAYS AS (
    CASE WHEN ended_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (ended_at - started_at))::integer * 1000
      ELSE NULL
    END
  ) STORED
);

-- Query recent runs per job
CREATE INDEX idx_pipeline_logs_job_time ON pipeline_logs (job_name, started_at DESC);

-- Query failures
CREATE INDEX idx_pipeline_logs_status ON pipeline_logs (status) WHERE status IN ('error', 'timeout');

-- Query running jobs (detect stuck jobs)
CREATE INDEX idx_pipeline_logs_running ON pipeline_logs (started_at) WHERE status = 'running';

-- Auto-cleanup: keep 30 days
CREATE OR REPLACE FUNCTION cleanup_old_pipeline_logs() RETURNS trigger AS $$
BEGIN
  DELETE FROM pipeline_logs WHERE started_at < now() - interval '30 days';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cleanup_pipeline_logs
  AFTER INSERT ON pipeline_logs
  FOR EACH STATEMENT
  EXECUTE FUNCTION cleanup_old_pipeline_logs();

-- View: latest run per job
CREATE OR REPLACE VIEW pipeline_job_status AS
SELECT DISTINCT ON (job_name)
  job_name,
  started_at,
  ended_at,
  status,
  records_processed,
  error_message,
  duration_ms,
  CASE
    WHEN status = 'running' AND started_at < now() - interval '30 minutes' THEN 'stuck'
    WHEN status = 'error' THEN 'failed'
    WHEN status = 'success' AND started_at < now() - interval '24 hours' THEN 'stale'
    WHEN status = 'success' THEN 'healthy'
    ELSE status
  END AS health_status
FROM pipeline_logs
ORDER BY job_name, started_at DESC;

-- View: job success rates (last 7 days)
CREATE OR REPLACE VIEW pipeline_job_stats AS
SELECT
  job_name,
  COUNT(*) as total_runs,
  COUNT(*) FILTER (WHERE status = 'success') as success_count,
  COUNT(*) FILTER (WHERE status = 'error') as error_count,
  COUNT(*) FILTER (WHERE status = 'timeout') as timeout_count,
  ROUND(
    COUNT(*) FILTER (WHERE status = 'success')::numeric / NULLIF(COUNT(*), 0) * 100, 1
  ) as success_rate,
  AVG(duration_ms) FILTER (WHERE status = 'success') as avg_duration_ms,
  MAX(started_at) as last_run_at,
  SUM(records_processed) as total_records_processed
FROM pipeline_logs
WHERE started_at > now() - interval '7 days'
GROUP BY job_name;

-- RLS
ALTER TABLE pipeline_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage pipeline_logs"
  ON pipeline_logs FOR ALL
  USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Admins can view pipeline_logs"
  ON pipeline_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.is_admin = true
    )
  );

COMMENT ON TABLE pipeline_logs IS 'Per-execution logs for all cron/pipeline jobs. Used for monitoring and auto-repair.';
