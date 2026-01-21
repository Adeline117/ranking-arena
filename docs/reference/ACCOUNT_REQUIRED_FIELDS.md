# 绑定账户后解锁字段清单

本文档定义了需要用户绑定交易所账号后才能解锁的数据字段。

## 数据分层说明

我们的数据分为三个层级：

1. **public_snapshot_***: 公开榜单快照数据
   - 来源：直接从交易所公开 API 抓取
   - 无需用户授权
   - 例如：ROI、胜率、粉丝数等

2. **derived_from_snapshot_***: 基于快照计算的数据
   - 来源：从公开快照派生计算
   - 无需用户授权
   - 例如：平均持仓时间（估算）、每周交易次数（估算）等

3. **account_required_***: 绑定账户后解锁的数据
   - 来源：需要用户授权访问私有交易数据
   - 需要用户绑定交易所账号
   - 例如：逐笔交易记录、持仓明细、盈亏分布等

## 绑定账户后解锁的字段清单

### 1. Trade-level Stats（逐笔交易统计）

- **total_trades**: 总交易次数
- **avg_profit**: 平均盈利
- **avg_loss**: 平均亏损
- **profitable_trades_pct**: 盈利交易百分比

### 2. Detailed Trading Metrics（详细交易指标）

- **avg_pnl**: 平均盈亏
- **max_drawdown**: 最大回撤
- **sharpe_ratio**: 夏普比率
- **sortino_ratio**: 索提诺比率

### 3. Holding Time Analysis（持仓时间分析）

- **avg_holding_time**: 平均持仓时间（基于实际交易数据）
- **median_holding_time**: 中位数持仓时间
- **short_term_trades_pct**: 短期交易（< 7 天）百分比
- **long_term_trades_pct**: 长期交易（> 30 天）百分比

### 4. Portfolio Breakdown（投资组合明细）

- **position_details**: 持仓明细
  - symbol: 交易对
  - direction: 方向（long/short）
  - invested_pct: 投资占比
  - entry_price: 入场价格
  - current_price: 当前价格
  - pnl: 盈亏
  - holding_time: 持仓时间

### 5. Profitability Analysis（盈利能力分析）

- **profitable_trades_count**: 盈利交易次数
- **losing_trades_count**: 亏损交易次数
- **largest_win**: 最大盈利
- **largest_loss**: 最大亏损
- **win_loss_ratio**: 盈亏比

### 6. Risk Metrics（风险指标）

- **volatility**: 波动率
- **beta**: 贝塔系数
- **var_95**: 95% 置信度的风险价值
- **max_leverage**: 最大杠杆

## 实现状态

**当前状态：仅定义，未实现**

这些字段已在本文档中定义，但尚未在代码中实现。实现这些字段需要：

1. 完善用户授权流程（确保用户同意访问其交易数据）
2. 实现交易数据抓取 API（从交易所获取私有数据）
3. 实现数据处理和存储逻辑
4. 更新前端 UI 展示这些字段

## 注意事项

- 所有 `account_required_*` 字段都需要用户明确授权
- 必须遵守交易所 API 的访问限制和速率限制
- 确保用户数据的隐私和安全
- 在 UI 中明确标识哪些数据需要绑定账户才能查看

