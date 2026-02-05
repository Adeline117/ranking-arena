-- Phase 1: 交易员扩展指标
-- 添加 sharpe_ratio 和 aum 字段到 trader_snapshots

-- 添加 sharpe_ratio 列
ALTER TABLE trader_snapshots
  ADD COLUMN IF NOT EXISTS sharpe_ratio DECIMAL(10, 4);

-- 添加 aum 列 (Assets Under Management)
ALTER TABLE trader_snapshots
  ADD COLUMN IF NOT EXISTS aum DECIMAL(20, 2);

-- 添加索引优化查询
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_sharpe_ratio
  ON trader_snapshots(sharpe_ratio DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_trader_snapshots_aum
  ON trader_snapshots(aum DESC NULLS LAST);

-- 添加注释
COMMENT ON COLUMN trader_snapshots.sharpe_ratio IS 'Sharpe ratio - risk-adjusted return metric';
COMMENT ON COLUMN trader_snapshots.aum IS 'Assets Under Management in USD';
