-- trader_latest: Hot path table for real-time leaderboard queries.
--
-- Root cause fix: trader_snapshots_v2 is append-only (10M rows/month, ~720 rows
-- per trader). compute-leaderboard scans 10M rows to find 15K latest snapshots.
-- trader_latest holds ONLY the latest snapshot per trader per window (~45K rows).
-- compute-leaderboard reads trader_latest instead → 200x fewer rows scanned.
--
-- Write pattern: UPSERT on (platform, trader_key, window) — always 1 row.
-- snapshots_v2 continues as cold archive for daily aggregation.

CREATE TABLE IF NOT EXISTS trader_latest (
  platform TEXT NOT NULL,
  market_type TEXT NOT NULL DEFAULT 'futures',
  trader_key TEXT NOT NULL,
  window TEXT NOT NULL,  -- '7D', '30D', '90D'

  -- Core metrics
  roi_pct NUMERIC,
  pnl_usd NUMERIC,
  win_rate NUMERIC,
  max_drawdown NUMERIC,
  trades_count INTEGER,
  followers INTEGER,
  copiers INTEGER,
  arena_score NUMERIC,

  -- Advanced metrics
  sharpe_ratio NUMERIC,
  sortino_ratio NUMERIC,
  calmar_ratio NUMERIC,
  volatility_pct NUMERIC,
  downside_volatility_pct NUMERIC,

  -- Extended data
  metrics JSONB,
  quality_flags JSONB,
  provenance JSONB,

  -- Timestamps
  updated_at TIMESTAMPTZ DEFAULT now(),
  fetched_at TIMESTAMPTZ DEFAULT now(),

  PRIMARY KEY (platform, trader_key, window)
);

-- Covering index for compute-leaderboard Phase 1 query pattern:
-- WHERE platform = ? AND window = ? ORDER BY updated_at DESC
CREATE INDEX IF NOT EXISTS idx_trader_latest_platform_window
  ON trader_latest (platform, window, updated_at DESC);

-- RLS (same as other pipeline tables — service role only)
ALTER TABLE trader_latest ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON trader_latest
  FOR ALL USING (true) WITH CHECK (true);

-- Seed from current latest snapshots (last 12h, deduplicated)
INSERT INTO trader_latest (
  platform, market_type, trader_key, window,
  roi_pct, pnl_usd, win_rate, max_drawdown, trades_count,
  followers, copiers, arena_score,
  sharpe_ratio, sortino_ratio, calmar_ratio,
  volatility_pct, downside_volatility_pct,
  metrics, quality_flags, updated_at, fetched_at
)
SELECT DISTINCT ON (platform, trader_key, "window")
  platform, market_type, trader_key, "window",
  roi_pct, pnl_usd, win_rate, max_drawdown, trades_count,
  followers, copiers, arena_score,
  sharpe_ratio, sortino_ratio, calmar_ratio,
  volatility_pct, downside_volatility_pct,
  metrics, quality_flags, updated_at, updated_at
FROM trader_snapshots_v2
WHERE updated_at > now() - interval '12 hours'
ORDER BY platform, trader_key, "window", updated_at DESC
ON CONFLICT (platform, trader_key, window) DO NOTHING;

COMMENT ON TABLE trader_latest IS 'Hot path: latest snapshot per trader per window. ~45K rows. UPSERT only. compute-leaderboard reads this instead of scanning 10M snapshots_v2 rows.';
