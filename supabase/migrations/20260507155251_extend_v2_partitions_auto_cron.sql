-- Migration: Extend trader_snapshots_v2 partitions + auto-create via pg_cron
-- Purpose: Create July-September 2026 partitions (June already exists).
--          Schedule monthly auto-creation so partitions are always 3 months ahead.

CREATE TABLE IF NOT EXISTS trader_snapshots_v2_p2026_07 PARTITION OF trader_snapshots_v2
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE IF NOT EXISTS trader_snapshots_v2_p2026_08 PARTITION OF trader_snapshots_v2
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE TABLE IF NOT EXISTS trader_snapshots_v2_p2026_09 PARTITION OF trader_snapshots_v2
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

-- Schedule monthly auto-creation (1st of each month at 00:05)
SELECT cron.unschedule('auto-create-v2-partitions')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-create-v2-partitions');

SELECT cron.schedule(
  'auto-create-v2-partitions',
  '5 0 1 * *',
  $$SELECT ensure_future_partitions(3)$$
);
