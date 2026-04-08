-- DB-level validation triggers for trader_daily_snapshots and trader_equity_curve
-- Completes the 3-table protection: snapshots_v2 + daily + equity_curve

-- trader_daily_snapshots: sanitize ROI, PnL, daily_return_pct, WR, MDD
CREATE OR REPLACE FUNCTION sanitize_daily_snapshot_on_write()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.roi IS NOT NULL AND (NEW.roi < -10000 OR NEW.roi > 10000) THEN NEW.roi := NULL; END IF;
  IF NEW.pnl IS NOT NULL AND (NEW.pnl < -10000000 OR NEW.pnl > 100000000) THEN NEW.pnl := NULL; END IF;
  IF NEW.daily_return_pct IS NOT NULL AND (NEW.daily_return_pct < -1000 OR NEW.daily_return_pct > 1000) THEN NEW.daily_return_pct := NULL; END IF;
  IF NEW.win_rate IS NOT NULL AND (NEW.win_rate < 0 OR NEW.win_rate > 100) THEN NEW.win_rate := NULL; END IF;
  IF NEW.max_drawdown IS NOT NULL AND (NEW.max_drawdown < 0 OR NEW.max_drawdown > 100) THEN NEW.max_drawdown := NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sanitize_daily_snapshot ON trader_daily_snapshots;
CREATE TRIGGER trg_sanitize_daily_snapshot
  BEFORE INSERT OR UPDATE ON trader_daily_snapshots
  FOR EACH ROW EXECUTE FUNCTION sanitize_daily_snapshot_on_write();

-- trader_equity_curve: sanitize ROI, PnL
CREATE OR REPLACE FUNCTION sanitize_equity_curve_on_write()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.roi_pct IS NOT NULL AND (NEW.roi_pct < -10000 OR NEW.roi_pct > 10000) THEN NEW.roi_pct := NULL; END IF;
  IF NEW.pnl_usd IS NOT NULL AND (NEW.pnl_usd < -10000000 OR NEW.pnl_usd > 1000000000) THEN NEW.pnl_usd := NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sanitize_equity_curve ON trader_equity_curve;
CREATE TRIGGER trg_sanitize_equity_curve
  BEFORE INSERT OR UPDATE ON trader_equity_curve
  FOR EACH ROW EXECUTE FUNCTION sanitize_equity_curve_on_write();
