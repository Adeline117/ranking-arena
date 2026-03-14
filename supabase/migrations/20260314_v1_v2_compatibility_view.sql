-- Migration: 20260314_v1_v2_compatibility_view
-- Description: Create compatibility view mapping trader_snapshots_v2 → v1 column names
-- Date: 2026-03-14
--
-- ============================================================================
-- V1 → V2 MIGRATION PLAN
-- ============================================================================
--
-- Current state:
--   - trader_snapshots (v1): Legacy table with 50+ columns, many unused
--     (sortino_ratio, calmar_ratio, beta_*, alpha, trading_style, etc.)
--   - trader_snapshots_v2: New table with clean schema (23 columns + metrics JSONB)
--   - Both tables coexist; all pipeline writes go to v2, but some reads still hit v1
--
-- Step 1 (THIS MIGRATION):
--   Create a compatibility view `trader_snapshots_v1_compat` that maps v2 data
--   back to v1 column names. This allows code that reads v1 to switch to the view
--   with minimal changes, while data continues flowing into v2.
--
-- Step 2: Switch remaining v1 read queries to use `trader_snapshots_v1_compat` view.
--   Grep for 'trader_snapshots' (excluding v2) across lib/, app/ and update references.
--
-- Step 3: Once all reads go through v2 (either directly or via view), rename:
--   - DROP TABLE trader_snapshots (old v1)
--   - ALTER TABLE trader_snapshots_v2 RENAME TO trader_snapshots
--   - Update view to point to renamed table
--
-- Step 4: Remove the compatibility view once all code uses v2 column names directly.
--   - DROP VIEW trader_snapshots_v1_compat
--   - Remove v2 suffix from all code references
--
-- ============================================================================

-- Compatibility view: v2 columns → v1 column names
-- Columns that exist in v1 but NOT in v2 are mapped to NULL with appropriate casts.
-- The metrics JSONB is unpacked for fields stored there in v2.

CREATE OR REPLACE VIEW trader_snapshots_v1_compat AS
SELECT
  -- Identity
  v2.id,
  v2.platform                             AS source,
  v2.trader_key                           AS source_trader_id,
  v2.window                               AS season_id,

  -- Core metrics (v2 top-level → v1 names)
  v2.roi_pct                              AS roi,
  v2.pnl_usd                             AS pnl,
  v2.win_rate,
  v2.max_drawdown,
  v2.trades_count,
  v2.followers,
  v2.copiers,
  v2.sharpe_ratio,
  v2.arena_score,

  -- Timestamps
  v2.created_at                           AS captured_at,
  v2.updated_at,
  v2.as_of_ts,

  -- v2 score components
  v2.return_score,
  v2.drawdown_score,
  v2.stability_score,

  -- From metrics JSONB (v2 stores some fields there)
  (v2.metrics->>'aum')::NUMERIC           AS aum,

  -- Period-specific columns: v1 had roi_7d, roi_30d etc. as separate columns.
  -- In v2, each period is a separate row (window = '7D', '30D', '90D').
  -- These are set to NULL here; callers should query by window instead.
  NULL::NUMERIC                           AS roi_7d,
  NULL::NUMERIC                           AS roi_30d,
  NULL::NUMERIC                           AS pnl_7d,
  NULL::NUMERIC                           AS pnl_30d,
  NULL::NUMERIC                           AS win_rate_7d,
  NULL::NUMERIC                           AS win_rate_30d,
  NULL::NUMERIC                           AS max_drawdown_7d,
  NULL::NUMERIC                           AS max_drawdown_30d,

  -- Rank: v1 had a rank column, v2 computes rank at query time
  NULL::INTEGER                           AS rank,

  -- Deprecated v1 columns (no equivalent in v2, always NULL)
  NULL::TIMESTAMPTZ                       AS tracked_since,
  NULL::TIMESTAMPTZ                       AS last_qualified_at,
  NULL::TIMESTAMPTZ                       AS full_confidence_at,
  NULL::NUMERIC                           AS sortino_ratio,
  NULL::NUMERIC                           AS calmar_ratio,
  NULL::NUMERIC                           AS profit_factor,
  NULL::NUMERIC                           AS recovery_factor,
  NULL::INTEGER                           AS max_consecutive_wins,
  NULL::INTEGER                           AS max_consecutive_losses,
  NULL::NUMERIC                           AS avg_holding_hours,
  NULL::NUMERIC                           AS volatility_pct,
  NULL::NUMERIC                           AS downside_volatility_pct,
  NULL::NUMERIC                           AS beta_btc,
  NULL::NUMERIC                           AS beta_eth,
  NULL::NUMERIC                           AS alpha,
  NULL::TEXT[]                            AS market_condition_tags,
  NULL::TEXT                              AS trading_style,
  NULL::TEXT[]                            AS asset_preference,
  NULL::NUMERIC                           AS style_confidence,
  NULL::NUMERIC                           AS pnl_score,
  NULL::NUMERIC                           AS alpha_score,
  NULL::NUMERIC                           AS consistency_score,
  NULL::NUMERIC                           AS risk_adjusted_score_v3,
  NULL::NUMERIC                           AS arena_score_v3,
  NULL::NUMERIC                           AS metrics_quality,
  NULL::INTEGER                           AS metrics_data_points,
  NULL::INTEGER                           AS holding_days,
  NULL::UUID                              AS authorization_id,
  FALSE                                   AS is_authorized,
  NULL::NUMERIC                           AS profitability_score,
  NULL::NUMERIC                           AS risk_control_score,
  NULL::NUMERIC                           AS execution_score,
  NULL::NUMERIC                           AS score_completeness,
  0::NUMERIC                              AS score_penalty,
  NULL::NUMERIC                           AS profit_loss_ratio,
  NULL::DATE                              AS snapshot_date,
  NULL::TEXT                              AS trader_type,

  -- v2-only fields exposed directly
  v2.market_type,
  v2.quality_flags,
  v2.provenance,
  v2.metrics

FROM trader_snapshots_v2 v2;

-- Grant read access (match existing RLS patterns)
-- Note: Views inherit the underlying table's RLS policies.
-- If trader_snapshots_v2 has public SELECT, this view is also publicly readable.

COMMENT ON VIEW trader_snapshots_v1_compat IS
  'Compatibility view mapping trader_snapshots_v2 columns to v1 names. '
  'Allows gradual migration of read queries from v1 table to v2 data. '
  'See migration file header for full v1→v2 migration plan.';
