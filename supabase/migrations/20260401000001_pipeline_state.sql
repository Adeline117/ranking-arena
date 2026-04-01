-- Pipeline state: persistent key-value store for cross-cron-run business state.
-- Replaces Redis TTL-based storage that caused the 6-day leaderboard freeze.
CREATE TABLE IF NOT EXISTS pipeline_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS (required by convention)
ALTER TABLE pipeline_state ENABLE ROW LEVEL SECURITY;

-- Service role can read/write
CREATE POLICY "service_role_all" ON pipeline_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Index for efficient lookups by prefix (e.g., all dead:consecutive:*)
CREATE INDEX idx_pipeline_state_prefix ON pipeline_state (key text_pattern_ops);

COMMENT ON TABLE pipeline_state IS 'Persistent key-value store for pipeline business state. Do NOT use for cache — use Redis for that.';
