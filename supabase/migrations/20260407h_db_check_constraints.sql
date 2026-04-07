-- P0-3: Database CHECK constraints — the last line of defense.
-- Bounds match VALIDATION_BOUNDS in lib/pipeline/types.ts exactly.
-- Even if all application validation fails, the DB rejects bad data.
-- NOT VALID avoids full table scan; VALIDATE runs async.

-- ═══════════════════════════════════════════════════════
-- trader_snapshots_v2
-- ═══════════════════════════════════════════════════════

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_roi_pct
  CHECK (roi_pct IS NULL OR (roi_pct >= -10000 AND roi_pct <= 10000))
  NOT VALID;

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_win_rate
  CHECK (win_rate IS NULL OR (win_rate >= 0 AND win_rate <= 100))
  NOT VALID;

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_max_drawdown
  CHECK (max_drawdown IS NULL OR (max_drawdown >= 0 AND max_drawdown <= 100))
  NOT VALID;

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_sharpe_ratio
  CHECK (sharpe_ratio IS NULL OR (sharpe_ratio >= -10 AND sharpe_ratio <= 10))
  NOT VALID;

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_arena_score
  CHECK (arena_score IS NULL OR (arena_score >= 0 AND arena_score <= 100))
  NOT VALID;

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_followers
  CHECK (followers IS NULL OR followers >= 0)
  NOT VALID;

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_copiers
  CHECK (copiers IS NULL OR copiers >= 0)
  NOT VALID;

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_trades_count
  CHECK (trades_count IS NULL OR trades_count >= 0)
  NOT VALID;

-- ═══════════════════════════════════════════════════════
-- leaderboard_ranks (fill gaps — win_rate/mdd already have CHECK)
-- ═══════════════════════════════════════════════════════

DO $$ BEGIN
  ALTER TABLE leaderboard_ranks
    ADD CONSTRAINT chk_lr_roi
    CHECK (roi IS NULL OR (roi >= -10000 AND roi <= 10000))
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE leaderboard_ranks
    ADD CONSTRAINT chk_lr_pnl
    CHECK (pnl IS NULL OR (pnl >= -100000000 AND pnl <= 1000000000))
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE leaderboard_ranks
    ADD CONSTRAINT chk_lr_arena_score
    CHECK (arena_score IS NULL OR (arena_score >= 0 AND arena_score <= 100))
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE leaderboard_ranks
    ADD CONSTRAINT chk_lr_sharpe_ratio
    CHECK (sharpe_ratio IS NULL OR (sharpe_ratio >= -10 AND sharpe_ratio <= 10))
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
