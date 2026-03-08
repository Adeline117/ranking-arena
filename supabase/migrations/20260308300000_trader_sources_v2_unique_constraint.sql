-- Add UNIQUE constraint on trader_sources_v2 for ON CONFLICT upsert support
-- Required by job-runner.ts enqueueDiscovery → runDiscovery
CREATE UNIQUE INDEX IF NOT EXISTS idx_trader_sources_v2_platform_market_trader
  ON trader_sources_v2 (platform, market_type, trader_key);
