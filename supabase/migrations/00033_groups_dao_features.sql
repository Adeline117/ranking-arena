-- ============================================
-- 00033: Groups DAO-Lite Features
-- ============================================

-- Add DAO-related columns to groups
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'groups' AND column_name = 'snapshot_space_id'
  ) THEN
    ALTER TABLE groups ADD COLUMN snapshot_space_id TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'groups' AND column_name = 'treasury_address'
  ) THEN
    ALTER TABLE groups ADD COLUMN treasury_address TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'groups' AND column_name = 'token_gate_address'
  ) THEN
    ALTER TABLE groups ADD COLUMN token_gate_address TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'groups' AND column_name = 'token_gate_min_balance'
  ) THEN
    ALTER TABLE groups ADD COLUMN token_gate_min_balance INTEGER DEFAULT 0;
  END IF;
END $$;
