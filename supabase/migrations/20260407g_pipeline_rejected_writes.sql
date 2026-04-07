-- Table to log rejected writes from the data validation gatekeeper.
-- Every row that fails validateBeforeWrite() is logged here instead of being written.

CREATE TABLE IF NOT EXISTS pipeline_rejected_writes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform text NOT NULL,
  trader_key text NOT NULL,
  target_table text NOT NULL,
  field text NOT NULL,
  value text,
  reason text NOT NULL,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for querying by platform/time
CREATE INDEX IF NOT EXISTS idx_rejected_writes_platform_time
  ON pipeline_rejected_writes (platform, created_at DESC);

-- Auto-cleanup: keep only 30 days
CREATE INDEX IF NOT EXISTS idx_rejected_writes_created
  ON pipeline_rejected_writes (created_at);

-- RLS: service_role only
ALTER TABLE pipeline_rejected_writes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON pipeline_rejected_writes
  FOR ALL TO service_role USING (true) WITH CHECK (true);
