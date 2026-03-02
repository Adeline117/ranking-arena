# 交易员主页数据分析

## 当前数据结构

### trader_snapshots 基础字段
```sql
- source (交易所来源)
- source_trader_id (交易所ID)
- rank (排名)
- roi (总ROI)
- pnl (总盈亏)
- win_rate (胜率)
- max_drawdown (最大回撤)
- trades_count (交易次数)
- followers (粉丝数)
- captured_at (数据快照时间)
```

### 扩展字段（需要确认）
- roi_7d, roi_30d, roi_90d (多时间段ROI)
- pnl_7d, pnl_30d (多时间段盈亏)
- win_rate_7d, win_rate_30d (多时间段胜率)
- max_drawdown_7d, max_drawdown_30d (多时间段回撤)
- sharpe_ratio (夏普比率)
- sortino_ratio (索提诺比率)
- profit_factor (盈亏比)
- calmar_ratio (卡玛比率)
- total_volume (总交易量)
- avg_holding_hours (平均持仓时间)
- trading_style (交易风格)

### Arena评分系统
- arena_score (综合评分)
- profitability_score (盈利能力评分)
- risk_control_score (风险控制评分)
- execution_score (执行力评分)

---

## CEX 数据能力分析

### 1. Binance Futures (币安合约)
**官网排行榜**: https://www.binance.com/en/futures-activity/leaderboard

**公开数据**:
- ✅ ROI (总收益率)
- ✅ PnL (总盈亏 USDT)
- ✅ Win Rate (胜率 %)
- ✅ Trades Count (交易次数)
- ✅ Followers (跟单人数)
- ❌ Max Drawdown (不公开)
- ❌ Sharpe/Sortino (不公开)
- ❌ 多时间段数据 (需要抓取历史)

**Detail API** (trader profile):
- ✅ 持仓历史 (Position History)
- ✅ 权益曲线 (Equity Curve)
- ✅ 盈亏分布 (PnL Distribution)
- ✅ Symbol统计 (Most traded pairs)

**数据特点**:
- 排行榜只有最新数据
- Detail API 有完整历史
- 需要 puppeteer 绕过 Cloudflare

---

### 2. Bybit (贝特)
**官网**: https://www.bybit.com/en/copy-trade/trade-center

**公开数据**:
- ✅ ROI (7D/30D/90D/ALL)
- ✅ PnL
- ✅ Win Rate
- ✅ Max Drawdown
- ✅ Sharpe Ratio
- ✅ Trades Count
- ✅ Followers (Copiers)
- ✅ AUM (管理资产)
- ✅ Trading Volume

**Detail API**:
- ✅ 多时间段完整数据
- ✅ 持仓历史
- ✅ 权益曲线
- ✅ Symbol分布

**数据特点**:
- **最完整的CEX数据**
- API友好，有官方文档
- 支持 7D/30D/90D/ALL 四个时间段

---

### 3. OKX (欧易)
**官网**: https://www.okx.com/copy-trading/rankings

**公开数据**:
- ✅ ROI (7D/30D/累计)
- ✅ PnL
- ✅ Win Rate
- ✅ Max Drawdown
- ✅ Sharpe Ratio
- ✅ Trades Count
- ✅ Followers
- ✅ AUM

**Detail API**:
- ✅ 持仓历史
- ✅ 权益曲线
- ✅ Symbol统计
- ❌ Web3 wallet data (geo-blocked)

**数据特点**:
- 数据完整度高
- Web3部分需要VPN
- Detail API被WAF保护

---

### 4. Bitget (芝麻开门)
**官网**: https://www.bitget.com/copytrading

**公开数据**:
- ✅ ROI (7D/30D/累计)
- ✅ PnL
- ✅ Win Rate
- ✅ Max Drawdown
- ✅ Followers
- ✅ AUM

**Detail API**:
- ✅ 持仓历史
- ✅ 权益曲线
- ⚠️  部分字段空值

**数据特点**:
- API稳定
- 数据质量中等
- Spot数据较少

---

### 5. Gate.io (芝麻开门)
**官网**: https://www.gate.io/copy_trading/futures

**公开数据**:
- ✅ ROI
- ✅ PnL
- ✅ Win Rate
- ❌ Max Drawdown (不公开)
- ✅ Followers

**Detail API**:
- ⚠️  需要Puppeteer
- ✅ 权益曲线
- ❌ MDD数据结构性缺失

**数据特点**:
- 数据完整度低
- 需要大量enrichment

---

### 6. MEXC (抹茶)
**官网**: https://www.mexc.com/copy-trading

**公开数据**:
- ✅ ROI
- ✅ PnL
- ✅ Win Rate
- ❌ Max Drawdown (不公开)
- ✅ Followers

**Detail API**:
- ✅ 权益曲线
- ⚠️  WR数据需要抓取

**数据特点**:
- API基础
- MDD需要从权益曲线计算

---

### 7. BingX (冰鑫)
**官网**: https://bingx.com/en-us/copy-trading/

**公开数据**:
- ✅ ROI
- ✅ PnL
- ✅ Win Rate
- ❌ Max Drawdown (不公开)
- ✅ Followers

**Detail API**:
- ⚠️  Spot数据用slug ID（不稳定）
- ⚠️  MDD无法获取

**数据特点**:
- Futures数据OK
- Spot数据质量差

---

### 8. HTX (火币)
**官网**: https://www.htx.com/copytrading

**公开数据**:
- ✅ ROI
- ✅ PnL
- ✅ Win Rate
- ✅ Followers

**数据特点**:
- 基础数据完整
- 缺少高级指标

---

## DEX 数据能力分析

### 1. Hyperliquid (HL)
**链上数据**:
- ✅ 所有交易历史（完全链上）
- ✅ 实时持仓
- ✅ 权益曲线（计算）
- ✅ PnL分布（计算）
- ✅ Symbol统计（计算）
- ✅ Win Rate（计算）
- ✅ Max Drawdown（计算）
- ✅ Sharpe/Sortino（计算）

**数据来源**:
- API: https://api.hyperliquid.xyz/info
- GraphQL: https://api.hyperliquid.xyz/graphql
- 所有数据完全透明

**可计算指标**:
- ✅ 所有CEX支持的指标
- ✅ 更详细的链上行为分析
- ✅ Gas费统计
- ✅ 交易频率分布

---

### 2. GMX V2
**链上数据**:
- ✅ 所有交易历史
- ✅ 持仓数据
- ✅ Funding Rate收益

**数据来源**:
- Subgraph: https://subgraph.satsuma-prod.com/...
- Direct contract calls

**可计算指标**:
- ✅ ROI / PnL / Win Rate
- ✅ Max Drawdown
- ✅ 持仓时长分析

---

### 3. dYdX V4
**链上数据**:
- ✅ 完整交易历史
- ✅ Funding payments
- ✅ Liquidation data

**数据来源**:
- Indexer API: https://indexer.dydx.trade/v4
- Validator nodes

---

### 4. Jupiter Perps (Solana)
**链上数据**:
- ✅ 完整交易历史
- ✅ 持仓数据

**数据来源**:
- RPC calls
- Jupiter API

---

## 数据完整性对比

| 数据项 | Binance | Bybit | OKX | Bitget | Gate | MEXC | HL | GMX | dYdX |
|--------|---------|-------|-----|--------|------|------|----|----|------|
| **ROI** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **PnL** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Win Rate** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Max Drawdown** | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Sharpe Ratio** | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Sortino Ratio** | ❌ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Profit Factor** | ❌ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| **7D/30D数据** | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ |
| **持仓历史** | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | ✅ |
| **权益曲线** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **AUM** | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Followers** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | N/A | N/A | N/A |

**图例**:
- ✅ 完整支持
- ⚠️  部分支持/需要计算
- ❌ 不支持/无法获取
- N/A 不适用

---

## 建议的数据展示方案

### 核心数据卡片（Overview）

#### 1. 收益表现
```
┌─────────────────────────────────────┐
│ 累计ROI: +127.5%                     │
│ 总盈亏: +$45,230 USDT                │
│                                     │
│ 7D:  +12.3% │ 30D: +45.2% │ 90D: +89.1% │
│ PnL: +$2.1K │ +$8.4K      │ +$18.7K    │
└─────────────────────────────────────┘
```

#### 2. 风险指标
```
┌─────────────────────────────────────┐
│ 胜率: 68.5%                          │
│ 最大回撤: -18.2%                     │
│                                     │
│ Sharpe: 2.4 │ Sortino: 3.1 │ PF: 2.8 │
│ Calmar: 1.9 │ 风险评分: 82/100       │
└─────────────────────────────────────┘
```

#### 3. 交易统计
```
┌─────────────────────────────────────┐
│ 总交易次数: 1,247                    │
│ 平均持仓: 18.5小时                   │
│ 管理资产: $125K                      │
│ 跟单用户: 342人                      │
└─────────────────────────────────────┘
```

### 图表展示

#### 1. 权益曲线 (Equity Curve)
- 时间段选择: 7D / 30D / 90D / ALL
- Y轴: ROI% 或 PnL$
- 对比基准: 平台平均 / BTC价格
- **所有交易所都有**

#### 2. 月度收益柱状图 (Monthly Performance)
- X轴: 月份
- Y轴: ROI%
- 颜色: 绿(正)/红(负)
- **需要计算** (从权益曲线)

#### 3. 盈亏分布饼图 (PnL Distribution)
- 大胜 (>10%)
- 小胜 (0-10%)
- 小亏 (0 to -10%)
- 大亏 (<-10%)
- **CEX部分支持，DEX需计算**

#### 4. 交易频率热力图 (Trading Heatmap)
- X轴: 小时 (0-23)
- Y轴: 星期 (周一-周日)
- 颜色深度: 交易次数
- **需要历史交易数据**

#### 5. Symbol分布雷达图 (Asset Breakdown)
- 最常交易的5-10个标的
- 维度: 交易次数 / 盈亏 / 胜率
- **CEX Detail API提供，DEX需计算**

#### 6. 回撤分析 (Drawdown Chart)
- 时间序列
- 显示每次回撤幅度和持续时间
- **需要权益曲线计算**

---

## 各交易所的展示策略

### 完整数据展示 (Bybit, OKX, Hyperliquid, GMX, dYdX)
- ✅ 所有图表全部显示
- ✅ 多时间段对比
- ✅ 完整风险指标
- ✅ 交易行为分析

### 基础数据展示 (Binance, Bitget, HTX)
- ✅ 权益曲线
- ✅ 基础收益/风险卡片
- ⚠️  部分图表（基于有的数据）
- ❌ 隐藏无法获取的指标

### 需要大量enrichment (Gate.io, MEXC, BingX)
- ✅ 权益曲线 (计算MDD)
- ⚠️  基础卡片
- ❌ 高级图表暂不显示
- 📝 标注"数据补全中"

---

## 优先级建议

### P0 (立即实现)
1. ✅ 权益曲线（所有交易所）
2. ✅ 收益表现卡片（ROI/PnL）
3. ✅ 风险指标卡片（WR/MDD）
4. ✅ 交易统计卡片（trades/AUM/followers）

### P1 (近期实现)
5. ✅ 月度收益柱状图
6. ✅ Symbol分布饼图
7. ✅ 多时间段对比（7D/30D/90D）
8. ✅ 回撤分析图表

### P2 (后续优化)
9. ⚠️  盈亏分布饼图
10. ⚠️  交易频率热力图
11. ⚠️  交易风格雷达图
12. ⚠️  与平台平均对比

---

## 数据缺失时的UI策略

### 1. 明确标注
```
┌─────────────────────────────────────┐
│ Sharpe Ratio: 数据不可用             │
│ (该交易所未公开此指标)                │
└─────────────────────────────────────┘
```

### 2. 灰色占位
```
┌─────────────────────────────────────┐
│ Max Drawdown: --                    │
│ 补全中...                            │
└─────────────────────────────────────┘
```

### 3. 替代方案
- Sharpe不可用 → 显示"风险调整后收益: 计算中"
- MDD不可用 → 从权益曲线计算（enrichment）

---

## 下一步行动

### 1. 数据库schema完善
- [ ] 确认所有扩展字段已存在
- [ ] 添加缺失的字段（profit_factor, calmar_ratio等）
- [ ] 创建position_history表

### 2. Enrichment脚本优化
- [ ] 统一所有7D/30D/90D数据获取
- [ ] 实现MDD计算（从权益曲线）
- [ ] 实现Sharpe/Sortino计算

### 3. 前端图表实现
- [ ] 权益曲线组件（lightweight-charts）
- [ ] 月度收益柱状图
- [ ] Symbol分布饼图
- [ ] 回撤分析图表

### 4. DEX数据计算
- [ ] Hyperliquid完整指标计算
- [ ] GMX V2数据聚合
- [ ] dYdX V4数据整合

---

生成时间: 2026-02-26
文档版本: v1.0
