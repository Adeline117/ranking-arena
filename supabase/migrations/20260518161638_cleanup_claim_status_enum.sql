-- Migration: 20260518161638_cleanup_claim_status_enum.sql
-- Remove 'approved' from trader_claims status CHECK constraint.
-- 'approved' was vestigial — code only uses 'verified' for successful claims.

-- First migrate any existing 'approved' rows (there are currently none)
UPDATE trader_claims SET status = 'verified' WHERE status = 'approved';

-- Recreate constraint without 'approved'
ALTER TABLE trader_claims DROP CONSTRAINT IF EXISTS trader_claims_status_check;
ALTER TABLE trader_claims ADD CONSTRAINT trader_claims_status_check
  CHECK (status IN ('pending', 'reviewing', 'verified', 'rejected'));
