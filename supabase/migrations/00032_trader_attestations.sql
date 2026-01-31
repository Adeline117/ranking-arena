-- ============================================
-- 00032: Trader Attestations — store on-chain EAS attestation references
-- ============================================

CREATE TABLE IF NOT EXISTS trader_attestations (
  trader_handle TEXT PRIMARY KEY,
  attestation_uid TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  arena_score INTEGER,
  published_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trader_attestations_uid
  ON trader_attestations(attestation_uid);

-- Allow public reads (attestations are meant to be verifiable)
ALTER TABLE trader_attestations ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Anyone can view trader attestations"
  ON trader_attestations FOR SELECT
  USING (true);

CREATE POLICY IF NOT EXISTS "Service role can manage attestations"
  ON trader_attestations FOR ALL
  USING (true)
  WITH CHECK (true);
