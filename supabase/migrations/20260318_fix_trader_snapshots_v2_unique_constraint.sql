-- Migration: Fix trader_snapshots_v2 ON CONFLICT failures
-- Date: 2026-03-18 04:00 PDT
-- Issue: All batch-fetch-traders jobs failing with "there is no unique or exclusion constraint matching the ON CONFLICT specification (42P10)"
-- Root Cause: Code uses ON CONFLICT (platform, market_type, trader_key, window) but table only had PRIMARY KEY (id)

-- Add missing unique constraint for upsert operations
ALTER TABLE trader_snapshots_v2 
ADD CONSTRAINT trader_snapshots_v2_unique 
UNIQUE (platform, market_type, trader_key, "window");

-- Note: "window" is a SQL reserved keyword and must be quoted
-- This constraint enables all upsert operations in:
-- - lib/cron/inline-jobs.ts (runWorkerInline, upsertLeaderboardData, syncTradersInline)
-- - connectors that use trader_snapshots_v2.upsert()
