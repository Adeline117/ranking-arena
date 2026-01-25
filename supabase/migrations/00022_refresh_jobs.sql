-- Migration: Create refresh_jobs table for job queue system
-- This table is used by the JobRunner to manage background refresh tasks

-- Create refresh_jobs table if not exists
CREATE TABLE IF NOT EXISTS refresh_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL,  -- 'DISCOVER', 'SNAPSHOT_REFRESH', 'PROFILE_REFRESH'
  platform TEXT NOT NULL,  -- 'binance', 'bybit', etc.
  trader_key TEXT,         -- Specific trader ID (null for discovery jobs)
  priority INTEGER DEFAULT 3,  -- 1=highest, 5=lowest
  status TEXT DEFAULT 'pending',  -- 'pending', 'running', 'completed', 'failed'
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  next_run_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add missing columns if table exists but columns don't
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'refresh_jobs' AND column_name = 'started_at') THEN
    ALTER TABLE refresh_jobs ADD COLUMN started_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'refresh_jobs' AND column_name = 'completed_at') THEN
    ALTER TABLE refresh_jobs ADD COLUMN completed_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'refresh_jobs' AND column_name = 'max_attempts') THEN
    ALTER TABLE refresh_jobs ADD COLUMN max_attempts INTEGER DEFAULT 3;
  END IF;
END $$;

-- Create indexes for efficient job claiming
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_pending ON refresh_jobs (status, next_run_at, priority) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_platform ON refresh_jobs (platform, status);
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_idempotency ON refresh_jobs (idempotency_key);

-- Function to clean up old completed/failed jobs (run periodically)
CREATE OR REPLACE FUNCTION cleanup_old_refresh_jobs()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM refresh_jobs
  WHERE status IN ('completed', 'failed')
    AND completed_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
