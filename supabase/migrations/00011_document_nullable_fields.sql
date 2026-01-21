-- 文档化可空字段
-- 版本: 1.0.0
-- 创建日期: 2026-01-21
--
-- 此迁移记录了 trader_snapshots 表中某些字段为什么需要支持 NULL 值
-- 不同交易所提供的数据完整性不同，特别是：
-- - GMX: 不提供 win_rate, max_drawdown, followers（无跟单功能）
-- - OKX Web3: 某些字段可能缺失
--
-- 参考文档: docs/EXCHANGE_FIELD_MAPPING.md

-- 添加字段注释说明可空原因
COMMENT ON COLUMN trader_snapshots.win_rate IS '胜率百分比 (0-100)。可能为 NULL：GMX 等交易所不提供此字段';
COMMENT ON COLUMN trader_snapshots.max_drawdown IS '最大回撤百分比。可能为 NULL：GMX 等交易所不提供此字段';
COMMENT ON COLUMN trader_snapshots.followers IS '跟单人数。可能为 NULL：GMX 无跟单功能';
COMMENT ON COLUMN trader_snapshots.pnl IS '盈亏金额 (USD)。可能为 NULL：某些交易所可能无法提取此数据';
COMMENT ON COLUMN trader_snapshots.trades_count IS '交易次数。可能为 NULL：部分交易所不提供此字段';

-- 添加表注释
COMMENT ON TABLE trader_snapshots IS '交易员快照数据。注意：不同交易所提供的字段完整性不同，GMX 等交易所的 win_rate, max_drawdown, followers 会为 NULL。参见 docs/EXCHANGE_FIELD_MAPPING.md';
