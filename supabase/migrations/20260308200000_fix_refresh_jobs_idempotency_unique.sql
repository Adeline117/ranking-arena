-- Fix: Add UNIQUE constraint on refresh_jobs.idempotency_key if missing.
-- The original migration used CREATE TABLE IF NOT EXISTS, which skips
-- if the table already existed without this constraint.

-- Add column if missing
ALTER TABLE refresh_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Add unique constraint if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'refresh_jobs_idempotency_key_key'
      AND conrelid = 'refresh_jobs'::regclass
  ) THEN
    ALTER TABLE refresh_jobs ADD CONSTRAINT refresh_jobs_idempotency_key_key UNIQUE (idempotency_key);
  END IF;
END $$;
