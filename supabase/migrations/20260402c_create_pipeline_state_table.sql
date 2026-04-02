-- Create pipeline_state table for persistent cross-cron-run state.
-- Fixes: PipelineState.get/set silently failed because table didn't exist,
-- causing compute-leaderboard degradation check to use inflated table count
-- as baseline instead of actual scored count.

CREATE TABLE IF NOT EXISTS public.pipeline_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Allow service role to read/write
ALTER TABLE public.pipeline_state ENABLE ROW LEVEL SECURITY;

-- Service role policy (bypasses RLS by default, but be explicit)
CREATE POLICY "Service role full access" ON public.pipeline_state
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Index for prefix queries (PipelineState.getByPrefix)
CREATE INDEX IF NOT EXISTS idx_pipeline_state_key_prefix ON public.pipeline_state (key text_pattern_ops);

COMMENT ON TABLE public.pipeline_state IS 'Persistent key-value store for pipeline state (replaces Redis TTL keys for business-critical state)';
