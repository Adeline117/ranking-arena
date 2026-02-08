-- Pipeline metrics table for monitoring data fetching health
CREATE TABLE IF NOT EXISTS pipeline_metrics (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL,
  metric_type text NOT NULL CHECK (metric_type IN ('fetch_success', 'fetch_error', 'fetch_duration', 'record_count')),
  value numeric NOT NULL DEFAULT 0,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pipeline_metrics_source_type_time
  ON pipeline_metrics (source, metric_type, created_at DESC);

-- Auto-cleanup: keep only 7 days of metrics
CREATE OR REPLACE FUNCTION cleanup_old_pipeline_metrics() RETURNS trigger AS $$
BEGIN
  DELETE FROM pipeline_metrics WHERE created_at < now() - interval '7 days';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cleanup_pipeline_metrics
  AFTER INSERT ON pipeline_metrics
  FOR EACH STATEMENT
  EXECUTE FUNCTION cleanup_old_pipeline_metrics();

COMMENT ON TABLE pipeline_metrics IS 'Data pipeline monitoring metrics - tracks fetch success/error/duration per source';
