-- 添加多时间段 ROI 列到 trader_snapshots 表
-- 这样每个交易员的记录都可以包含 7D、30D、90D 的 ROI

ALTER TABLE trader_snapshots 
ADD COLUMN IF NOT EXISTS roi_7d NUMERIC(20, 8),
ADD COLUMN IF NOT EXISTS roi_30d NUMERIC(20, 8),
ADD COLUMN IF NOT EXISTS pnl_7d NUMERIC(20, 8),
ADD COLUMN IF NOT EXISTS pnl_30d NUMERIC(20, 8),
ADD COLUMN IF NOT EXISTS win_rate_7d NUMERIC(10, 4),
ADD COLUMN IF NOT EXISTS win_rate_30d NUMERIC(10, 4),
ADD COLUMN IF NOT EXISTS max_drawdown_7d NUMERIC(10, 4),
ADD COLUMN IF NOT EXISTS max_drawdown_30d NUMERIC(10, 4);

-- 添加注释
COMMENT ON COLUMN trader_snapshots.roi_7d IS '7天ROI';
COMMENT ON COLUMN trader_snapshots.roi_30d IS '30天ROI';
COMMENT ON COLUMN trader_snapshots.pnl_7d IS '7天盈亏';
COMMENT ON COLUMN trader_snapshots.pnl_30d IS '30天盈亏';
COMMENT ON COLUMN trader_snapshots.win_rate_7d IS '7天胜率';
COMMENT ON COLUMN trader_snapshots.win_rate_30d IS '30天胜率';
COMMENT ON COLUMN trader_snapshots.max_drawdown_7d IS '7天最大回撤';
COMMENT ON COLUMN trader_snapshots.max_drawdown_30d IS '30天最大回撤';


