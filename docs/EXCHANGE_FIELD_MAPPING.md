# 交易所字段映射文档

> 基准平台：Binance Copy Trading
>
> 最后更新：2026-01-21

---

## 一、Binance 交易员主页字段清单（UI 顺序：Top → Bottom）

### 1. Header 区域（顶部信息卡片）

| 序号 | 字段名 | 页面位置 | 字段含义 | 数据类型 | 核心字段 |
|------|--------|----------|----------|----------|----------|
| 1 | Avatar | Header 左侧 | 交易员头像图片 | string (URL) | 否 |
| 2 | Nickname | Header 头像右侧 | 交易员昵称/显示名 | string | 是 |
| 3 | Verified Badge | 昵称旁边 | 是否通过身份验证 | boolean | 否 |
| 4 | Trading Style Tag | 昵称下方 | 交易风格标签（如 Swing、Scalp） | string | 否 |
| 5 | Bio / Introduction | Header 下方 | 交易员个人简介 | string | 否 |
| 6 | Follow Button | Header 右侧 | 关注/跟单按钮 | - | - |

### 2. Stats 卡片区域（核心指标）

| 序号 | 字段名 | 页面位置 | 字段含义 | 数据类型 | 核心字段 |
|------|--------|----------|----------|----------|----------|
| 7 | ROI | Stats 卡片第一行 | 投资回报率（带时间段选择器：7D/30D/90D） | % (number) | **是** |
| 8 | PnL | Stats 卡片第一行 | 盈亏金额（USD） | number (USD) | **是** |
| 9 | Win Rate | Stats 卡片第二行 | 胜率百分比 | % (number) | **是** |
| 10 | Max Drawdown (MDD) | Stats 卡片第二行 | 最大回撤百分比 | % (number) | **是** |
| 11 | Sharpe Ratio | Stats 卡片第二行 | 夏普比率（风险调整后收益） | number | 否 |
| 12 | Current Copiers | Stats 卡片第三行 | 当前跟单人数 | number (int) | **是** |
| 13 | Total Copiers | Stats 卡片第三行 | 累计跟单人数 | number (int) | 否 |
| 14 | AUM | Stats 卡片第三行 | 资产管理规模（Assets Under Management） | number (USD) | 否 |
| 15 | Copiers' PnL | Stats 卡片第三行 | 跟单者总收益 | number (USD) | 否 |

### 3. 时间段选择器

| 序号 | 字段名 | 页面位置 | 字段含义 | 数据类型 | 核心字段 |
|------|--------|----------|----------|----------|----------|
| 16 | Time Period Selector | Stats 上方 Tab | 可选时间范围（7D/30D/90D/1Y/All） | enum | **是** |

### 4. Performance 图表区域

| 序号 | 字段名 | 页面位置 | 字段含义 | 数据类型 | 核心字段 |
|------|--------|----------|----------|----------|----------|
| 17 | ROI Chart | 图表区域 | 收益率曲线图（按日） | array[{date, roi}] | 否 |
| 18 | PnL Chart | 图表区域（切换 Tab） | 盈亏曲线图（按日） | array[{date, pnl}] | 否 |
| 19 | Equity Curve | 图表区域 | 权益曲线 | array[{date, equity}] | 否 |

### 5. Trading Statistics 区域（详细统计）

| 序号 | 字段名 | 页面位置 | 字段含义 | 数据类型 | 核心字段 |
|------|--------|----------|----------|----------|----------|
| 20 | Total Trades | 统计区域 | 交易总次数 | number (int) | 否 |
| 21 | Profitable Trades | 统计区域 | 盈利交易次数 | number (int) | 否 |
| 22 | Profitable Trades % | 统计区域 | 盈利交易占比 | % (number) | 否 |
| 23 | Avg Holding Time | 统计区域 | 平均持仓时长 | time (hours/days) | 否 |
| 24 | Avg Profit | 统计区域 | 平均每笔利润 | number (USD) | 否 |
| 25 | Avg Loss | 统计区域 | 平均每笔亏损 | number (USD) | 否 |
| 26 | Largest Win | 统计区域 | 最大单笔盈利 | number (USD) | 否 |
| 27 | Largest Loss | 统计区域 | 最大单笔亏损 | number (USD) | 否 |
| 28 | Risk Score | 统计区域 | 风险评分（Binance 自有指标） | number (1-5) | 否 |
| 29 | Profitable Weeks | 统计区域 | 盈利周数 | number (int) | 否 |

### 6. Asset Preference 区域（资产偏好）

| 序号 | 字段名 | 页面位置 | 字段含义 | 数据类型 | 核心字段 |
|------|--------|----------|----------|----------|----------|
| 30 | Asset Symbol | 饼图/列表 | 交易资产代码（BTC, ETH 等） | string | 否 |
| 31 | Asset Weight % | 饼图/列表 | 该资产占比 | % (number) | 否 |

### 7. Current Positions 区域（当前持仓）

| 序号 | 字段名 | 页面位置 | 字段含义 | 数据类型 | 核心字段 |
|------|--------|----------|----------|----------|----------|
| 32 | Position Symbol | 持仓表格 | 交易对（如 BTCUSDT） | string | 否 |
| 33 | Position Direction | 持仓表格 | 方向（Long/Short） | enum | 否 |
| 34 | Entry Price | 持仓表格 | 入场价格 | number | 否 |
| 35 | Invested % | 持仓表格 | 投入占比 | % (number) | 否 |
| 36 | Unrealized PnL | 持仓表格 | 未实现盈亏 | number (USD) | 否 |
| 37 | Leverage | 持仓表格 | 杠杆倍数 | number | 否 |
| 38 | Margin Mode | 持仓表格 | 保证金模式（Cross/Isolated） | enum | 否 |

### 8. Position History 区域（历史持仓）

| 序号 | 字段名 | 页面位置 | 字段含义 | 数据类型 | 核心字段 |
|------|--------|----------|----------|----------|----------|
| 39 | Position Symbol | 历史表格 | 交易对 | string | 否 |
| 40 | Position Direction | 历史表格 | 方向 | enum | 否 |
| 41 | Position Type | 历史表格 | 类型（Perpetual/Delivery） | enum | 否 |
| 42 | Open Time | 历史表格 | 开仓时间 | timestamp | 否 |
| 43 | Close Time | 历史表格 | 平仓时间 | timestamp | 否 |
| 44 | Entry Price | 历史表格 | 开仓均价 | number | 否 |
| 45 | Exit Price | 历史表格 | 平仓均价 | number | 否 |
| 46 | Max Position Size | 历史表格 | 最大持仓量 | number | 否 |
| 47 | Closed Size | 历史表格 | 已平仓量 | number | 否 |
| 48 | Realized PnL | 历史表格 | 已实现盈亏（USD） | number | 否 |
| 49 | Realized PnL % | 历史表格 | 已实现盈亏百分比 | % (number) | 否 |
| 50 | Status | 历史表格 | 状态（Partial/Closed） | enum | 否 |

### 9. 排行榜列表字段（Leaderboard View）

| 序号 | 字段名 | 页面位置 | 字段含义 | 数据类型 | 核心字段 |
|------|--------|----------|----------|----------|----------|
| 51 | Rank | 表格第一列 | 排名名次 | number (int) | **是** |
| 52 | Avatar + Nickname | 表格第二列 | 交易员头像和昵称 | string | **是** |
| 53 | ROI | 表格列 | 收益率 | % (number) | **是** |
| 54 | PnL | 表格列 | 盈亏金额 | number (USD) | **是** |
| 55 | Win Rate | 表格列 | 胜率 | % (number) | **是** |
| 56 | MDD | 表格列 | 最大回撤 | % (number) | **是** |
| 57 | Copiers | 表格列 | 跟单人数 | number (int) | **是** |
| 58 | Trades | 表格列 | 交易次数 | number (int) | 否 |

---

## 二、其他交易所字段对照表

### 核心字段对照

| Binance 字段 | Bybit | OKX | Bitget | MEXC | GMX |
|--------------|-------|-----|--------|------|-----|
| **ROI** | ROI / 收益率 | ROI / pnlRate | 收益率 / ROI | roi / totalRoi | ROI |
| **PnL** | PnL / Profit / 收益 | pnl / profit / totalPnl | 总收益 / 累计收益 | totalPnl / pnl | PnL |
| **Win Rate** | Win Rate / 胜率 | winRate | 胜率 | winRate | **无** |
| **Max Drawdown** | Max Drawdown / MDD | mdd / maxDrawdown | 最大回撤 / MDD | maxDrawdown / mdd | **无** |
| **Current Copiers** | Followers / Copiers | followers / copierCount | 当前跟单人数 | followerCount / copierCount | **无** |
| **Total Copiers** | Total Copiers | **无** | 累计跟单人数 | **无** | **无** |
| **AUM** | AUM / 管理资产 | **无** | AUM | **无** | **无** |
| **Copiers' PnL** | Copier(s) PnL | **无** | 跟单者收益 | **无** | **无** |
| **Total Trades** | Total Trades | **无** | **无** | totalTrades | Trades |
| **Sharpe Ratio** | Sharpe Ratio | **无** | **无** | sharpeRatio | **无** |
| **Avg Holding Time** | Avg Holding (D/days) | **无** | 平均持仓时长 | **无** | **无** |
| **Rank** | 排名 | 排名 | 排名 | 排名 | Rank |
| **Nickname** | 昵称 | nickname / name | 昵称 | 昵称 | Address |

### 详细字段对照（按交易所）

#### Bybit

| Binance 字段 | Bybit 对应 | 备注 |
|--------------|------------|------|
| ROI | `ROI` / `收益率` | 通过正则提取：`/(?:ROI|收益率)[:\s]*([+-]?\d+(?:,\d+)*\.?\d*)%/i` |
| PnL | `PnL` / `Profit` / `收益` | `/(?:PnL|收益|Profit)[:\s]*\$?([+-]?[\d,]+\.?\d*)/i` |
| Win Rate | `Win Rate` / `胜率` | `/(?:Win Rate|胜率)[:\s]*(\d+\.?\d*)%/i` |
| Max Drawdown | `Max Drawdown` / `MDD` | `/(?:Max Drawdown|MDD)[:\s]*([+-]?\d+\.?\d*)%/i` |
| Copiers | `Followers` / `Copiers` | `/(?:Followers|Copiers)[:\s]*([\d,]+)/i` |
| Total Trades | `Total Trades` | `/(?:Total Trades)[:\s]*(\d+)/i` |
| Avg Holding Time | `Avg Holding` | `/(?:Avg Holding)[:\s]*(\d+)(?:D|days?)?/i` |
| Sharpe Ratio | `Sharpe Ratio` | `/(?:Sharpe Ratio)[:\s]*([+-]?\d+\.?\d*)/i` |
| Copiers' PnL | `Copier(s) PnL` | `/(?:Copier(?:s)? PnL)[:\s]*\$?([+-]?[\d,]+\.?\d*)/i` |
| AUM | `AUM` / `管理资产` | `/(?:AUM|管理资产)[:\s]*\$?([\d,]+\.?\d*)([KM])?/i` |

**时间范围**: 7D, 30D, 90D

#### OKX (Web3 Copy Trading)

| Binance 字段 | OKX 对应 | 备注 |
|--------------|----------|------|
| ROI | `roi` / `pnlRate` | 可能是小数（< 10 则 × 100） |
| PnL | `pnl` / `profit` / `totalPnl` | USD |
| Win Rate | `winRate` | 检查是否 0-1，需标准化 |
| Max Drawdown | `mdd` / `maxDrawdown` | 百分比 |
| Copiers | `followers` / `copierCount` | 整数 |
| Nickname | `nickname` / `name` / `displayName` | |
| Avatar | `avatar` / `avatarUrl` | |
| Trader ID | `address` / `traderId` / `uid` / `id` | Web3 用钱包地址 |

**时间范围**: 7D, 30D, 90D

**缺失字段**:
- Total Trades
- Sharpe Ratio
- AUM
- Copiers' PnL
- Avg Holding Time

#### Bitget

| Binance 字段 | Bitget 对应 | 备注 |
|--------------|-------------|------|
| ROI | `收益率` / `ROI` | `/收益率[:\s]*([+-]?\d+\.?\d*)%/i` |
| PnL | `总收益` / `累计收益` | `/总收益[:\s]*\$?([\d,]+\.?\d*)/i` |
| Win Rate | `胜率` | `/胜率[:\s]*(\d+\.?\d*)%/i` |
| Max Drawdown | `最大回撤` / `MDD` | `/最大回撤[:\s]*([+-]?\d+\.?\d*)%/i` |
| Total Copiers | `累计跟单人数` | `/累计跟单人数[:\s]*([\d,]+)/i` |
| Trade Frequency | `交易频率` | Binance 无此字段 |
| Avg Holding Time | `平均持仓时长` | `/平均持仓时长[:\s]*(\d+)天?(\d+)?小时?/i` |
| Copiers' PnL | `跟单者收益` | `/跟单者收益[:\s]*\$?([+-]?[\d,]+\.?\d*)/i` |

**缺失字段**:
- Sharpe Ratio
- AUM

#### MEXC

| Binance 字段 | MEXC 对应 | 备注 |
|--------------|-----------|------|
| ROI | `roi` / `totalRoi` | API 响应 |
| PnL | `totalPnl` / `pnl` | |
| Win Rate | `winRate` | |
| Max Drawdown | `maxDrawdown` / `mdd` | |
| Copiers | `followerCount` / `copierCount` | |
| Total Trades | `totalTrades` | |
| Sharpe Ratio | `sharpeRatio` | |

**监听 API URL**: `trader/detail`, `leader/info`, `position`, `history`, `order`

**缺失字段**:
- AUM
- Total Copiers（历史累计）
- Copiers' PnL
- Avg Holding Time

#### GMX

| Binance 字段 | GMX 对应 | 备注 |
|--------------|----------|------|
| ROI | `ROI` | 从表格提取 |
| PnL | `PnL` | |
| Rank | `Rank` | |
| Trades | `Trades` | |

**重大缺失**:
- ❌ Win Rate
- ❌ Max Drawdown
- ❌ Copiers（无跟单功能）
- ❌ AUM
- ❌ Sharpe Ratio
- ❌ 所有持仓数据

**时间范围**: **仅 7D, 30D**（无 90D）

**特点**: GMX 是 DeFi 协议，主要展示链上交易数据，非传统 Copy Trading 平台

---

## 三、字段一致性审计（同名不同义）

### 1. ROI vs PnL 定义差异

| 交易所 | ROI 定义 | PnL 定义 | 是否可直接对比 |
|--------|---------|---------|---------------|
| Binance | 百分比收益率（基于初始资金） | 绝对盈亏金额（USD） | ✅ 可对比 |
| Bybit | 同上 | 同上 | ✅ 可对比 |
| OKX | ⚠️ 可能是小数（0.xx）需 ×100 | 同上 | ⚠️ 需标准化 |
| Bitget | 同上 | 同上 | ✅ 可对比 |
| MEXC | 同上 | 同上 | ✅ 可对比 |
| GMX | 同上 | 同上 | ✅ 可对比 |

### 2. Win Rate 定义差异

| 交易所 | 格式 | 定义 | 是否可直接对比 |
|--------|------|------|---------------|
| Binance | 0-100 (%) | 盈利交易数 / 总交易数 | ✅ 基准 |
| Bybit | 0-100 (%) | 同上 | ✅ 可对比 |
| OKX | ⚠️ 可能 0-1 或 0-100 | 同上 | ⚠️ 需检查 |
| Bitget | 0-100 (%) | 同上 | ✅ 可对比 |
| MEXC | 0-100 (%) | 同上 | ✅ 可对比 |
| GMX | **无** | - | ❌ 不可用 |

### 3. 时间窗口差异

| 交易所 | 支持的时间段 | 默认展示 |
|--------|-------------|---------|
| Binance | 7D, 30D, 90D, 1Y, All | 30D |
| Bybit | 7D, 30D, 90D | 30D |
| OKX | 7D, 30D, 90D | 30D |
| Bitget | 7D, 30D, 90D | 30D |
| MEXC | 7D, 30D, 90D | 30D |
| GMX | **仅 7D, 30D** | 7D |

**⚠️ GMX 无 90D 数据，跨交易所比较时需特别标注**

### 4. Realized vs Unrealized PnL

| 字段 | 含义 | 哪些交易所有 |
|------|------|-------------|
| PnL (Stats 卡片) | 通常为 Realized（已平仓） | 所有 |
| Unrealized PnL | 当前持仓未实现盈亏 | Binance, Bybit, Bitget |
| Total PnL | Realized + Unrealized | 部分交易所 |

**⚠️ 不同交易所的 PnL 可能包含不同内容，需确认是否仅统计 Realized**

### 5. Copiers 定义差异

| 交易所 | 字段名 | 含义 | 差异 |
|--------|--------|------|------|
| Binance | Current Copiers | 当前正在跟单的人数 | 动态变化 |
| Binance | Total Copiers | 历史累计跟单人数 | 只增不减 |
| Bybit | Followers/Copiers | 混用，需确认 | ⚠️ 可能是 Current |
| Bitget | 累计跟单人数 | Total Copiers | ✅ 明确 |
| OKX | copierCount | 当前 | ⚠️ 可能是 Current |
| MEXC | followerCount | 当前 | ⚠️ 可能是 Current |
| GMX | **无** | 无跟单功能 | ❌ |

---

## 四、字段缺失影响评估

### 影响等级定义

- **致命**：缺失此字段无法参与排名
- **高**：排名结果会有明显偏差
- **可接受**：可降级显示，对排名影响较小

### 评估表

| 缺失字段 | GMX | OKX | MEXC | Bitget | Bybit | 影响等级 |
|----------|-----|-----|------|--------|-------|---------|
| ROI | ✅ | ✅ | ✅ | ✅ | ✅ | - |
| PnL | ✅ | ✅ | ✅ | ✅ | ✅ | - |
| Win Rate | ❌ | ✅ | ✅ | ✅ | ✅ | **高** |
| Max Drawdown | ❌ | ✅ | ✅ | ✅ | ✅ | **高** |
| Copiers | ❌ | ✅ | ✅ | ✅ | ✅ | 可接受 |
| Total Trades | ✅ | ❌ | ✅ | ❌ | ✅ | 可接受 |
| Sharpe Ratio | ❌ | ❌ | ✅ | ❌ | ✅ | 可接受 |
| AUM | ❌ | ❌ | ❌ | ❌ | ✅ | 可接受 |
| Avg Holding Time | ❌ | ❌ | ❌ | ✅ | ✅ | 可接受 |
| 90D 时间段 | ❌ | ✅ | ✅ | ✅ | ✅ | **高** |

### GMX 特别说明

**缺失致命字段**：
- Win Rate（无法计算稳定性评分）
- Max Drawdown（无法计算回撤评分）
- 90D 数据（无法使用标准评分权重）

**建议处理**：
1. GMX 交易员单独分组排名
2. 或使用简化评分公式（仅基于 ROI）
3. 明确标注"数据有限"

---

## 五、人工可核对抓取清单

### Binance Copy Trading

| 字段 | 页面可见 | 需要登录 | 需要特殊操作 | 抓取难度 |
|------|---------|---------|-------------|---------|
| Avatar | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Nickname | ✅ 是 | ❌ 否 | ❌ | 简单 |
| ROI | ✅ 是 | ❌ 否 | Tab 切换时间段 | 简单 |
| PnL | ✅ 是 | ❌ 否 | Tab 切换时间段 | 简单 |
| Win Rate | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Max Drawdown | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Copiers | ✅ 是 | ❌ 否 | ❌ | 简单 |
| AUM | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Sharpe Ratio | ✅ 是 | ❌ 否 | ❌ | 简单 |
| ROI Chart 数据 | ✅ 是 | ❌ 否 | 需解析图表 API | 中等 |
| Current Positions | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Position History | ✅ 是 | ❌ 否 | 分页加载 | 中等 |
| Asset Breakdown | ✅ 是 | ❌ 否 | ❌ | 简单 |

### Bybit Copy Trading

| 字段 | 页面可见 | 需要登录 | 需要特殊操作 | 抓取难度 |
|------|---------|---------|-------------|---------|
| Avatar | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Nickname | ✅ 是 | ❌ 否 | ❌ | 简单 |
| ROI | ✅ 是 | ❌ 否 | Tab 切换 | 简单 |
| PnL | ✅ 是 | ❌ 否 | Tab 切换 | 简单 |
| Win Rate | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Max Drawdown | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Copiers | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Sharpe Ratio | ✅ 是 | ❌ 否 | 详情页 | 中等 |
| AUM | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Copiers' PnL | ✅ 是 | ❌ 否 | ❌ | 简单 |

### OKX Web3 Copy Trading

| 字段 | 页面可见 | 需要登录 | 需要特殊操作 | 抓取难度 |
|------|---------|---------|-------------|---------|
| Wallet Address | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Nickname | ✅ 是 | ❌ 否 | ❌ | 简单 |
| ROI | ✅ 是 | ❌ 否 | Tab 切换 | 简单 |
| PnL | ✅ 是 | ❌ 否 | Tab 切换 | 简单 |
| Win Rate | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Max Drawdown | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Copiers | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Sharpe Ratio | ❌ 否 | - | - | 无法抓取 |
| AUM | ❌ 否 | - | - | 无法抓取 |

### Bitget Copy Trading

| 字段 | 页面可见 | 需要登录 | 需要特殊操作 | 抓取难度 |
|------|---------|---------|-------------|---------|
| Avatar | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Nickname | ✅ 是 | ❌ 否 | ❌ | 简单 |
| ROI | ✅ 是 | ❌ 否 | Tab 切换 | 简单 |
| PnL | ✅ 是 | ❌ 否 | Tab 切换 | 简单 |
| Win Rate | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Max Drawdown | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Total Copiers | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Copiers' PnL | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Avg Holding Time | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Trade Frequency | ✅ 是 | ❌ 否 | ❌ | 简单 |

### MEXC Copy Trading

| 字段 | 页面可见 | 需要登录 | 需要特殊操作 | 抓取难度 |
|------|---------|---------|-------------|---------|
| Avatar | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Nickname | ✅ 是 | ❌ 否 | ❌ | 简单 |
| ROI | ✅ 是 | ❌ 否 | API 拦截 | 中等 |
| PnL | ✅ 是 | ❌ 否 | API 拦截 | 中等 |
| Win Rate | ✅ 是 | ❌ 否 | API 拦截 | 中等 |
| Max Drawdown | ✅ 是 | ❌ 否 | API 拦截 | 中等 |
| Copiers | ✅ 是 | ❌ 否 | API 拦截 | 中等 |
| Total Trades | ✅ 是 | ❌ 否 | API 拦截 | 中等 |
| Sharpe Ratio | ✅ 是 | ❌ 否 | API 拦截 | 中等 |

### GMX Leaderboard

| 字段 | 页面可见 | 需要登录 | 需要特殊操作 | 抓取难度 |
|------|---------|---------|-------------|---------|
| Wallet Address | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Rank | ✅ 是 | ❌ 否 | ❌ | 简单 |
| ROI | ✅ 是 | ❌ 否 | Tab 切换(7D/30D) | 简单 |
| PnL | ✅ 是 | ❌ 否 | Tab 切换 | 简单 |
| Trades | ✅ 是 | ❌ 否 | ❌ | 简单 |
| Win Rate | ❌ 否 | - | - | **不可用** |
| Max Drawdown | ❌ 否 | - | - | **不可用** |
| 90D 数据 | ❌ 否 | - | - | **不可用** |

---

## 六、最小可统一字段集合

### 核心排名字段（必须）

所有交易所都必须提供以下字段才能参与统一排名：

```typescript
interface MinimumRankingFields {
  // === 必填字段 ===
  source: string;              // 交易所标识
  source_trader_id: string;    // 交易所内 ID
  handle: string;              // 昵称/地址

  // 核心性能指标
  roi: number;                 // 收益率 (%)，必填
  pnl: number;                 // 盈亏金额 (USD)，必填

  // 时间段
  period: '7D' | '30D' | '90D';

  // === 可选但推荐 ===
  win_rate?: number | null;    // 胜率 (%)，GMX 无
  max_drawdown?: number | null; // 最大回撤 (%)，GMX 无
  followers?: number | null;   // 跟单人数，GMX 无
  trades_count?: number | null; // 交易次数
  avatar_url?: string | null;  // 头像
}
```

### 扩展展示字段（可选）

```typescript
interface ExtendedDisplayFields {
  // 仅用于展示，不参与排名计算
  aum?: number | null;              // AUM，仅 Bybit 有
  copiers_pnl?: number | null;      // 跟单者收益
  sharpe_ratio?: number | null;     // 夏普比率
  avg_holding_time?: number | null; // 平均持仓时长
  total_copiers?: number | null;    // 累计跟单人数

  // 历史数据
  equity_curve?: EquityCurvePoint[]; // 权益曲线
  asset_breakdown?: AssetWeight[];   // 资产分布
  positions?: Position[];            // 持仓信息
}
```

### Nullable 字段规则

| 字段 | 必须 Nullable | 原因 |
|------|--------------|------|
| win_rate | ✅ 是 | GMX 无此字段 |
| max_drawdown | ✅ 是 | GMX 无此字段 |
| followers | ✅ 是 | GMX 无跟单功能 |
| aum | ✅ 是 | 仅 Bybit 有 |
| copiers_pnl | ✅ 是 | 部分交易所无 |
| sharpe_ratio | ✅ 是 | 部分交易所无 |
| avg_holding_time | ✅ 是 | 部分交易所无 |
| trades_count | ✅ 是 | 部分交易所无 |

### 排名可用 vs 仅展示

| 字段 | 可用于排名 | 仅用于展示 | 原因 |
|------|-----------|-----------|------|
| roi | ✅ | | 核心指标，所有交易所有 |
| pnl | ✅ | | 核心指标，所有交易所有 |
| win_rate | ⚠️ 有条件 | | GMX 无，需降级处理 |
| max_drawdown | ⚠️ 有条件 | | GMX 无，需降级处理 |
| followers | | ✅ | 不同定义，不宜直接比较 |
| aum | | ✅ | 覆盖率低 |
| sharpe_ratio | | ✅ | 覆盖率低 |
| trades_count | | ✅ | 交易频率差异大 |

### Arena Score 计算兼容性

```
标准评分（有完整数据）：
  arena_score = return_score(0-85) + drawdown_score(0-8) + stability_score(0-7)

降级评分（GMX 等缺失数据）：
  arena_score = return_score(0-85) + default_penalty(-15)

  或单独分组排名，不与完整数据交易所混排
```

---

## 七、数据标准化规则

### ROI 标准化

```javascript
function normalizeROI(value, source) {
  // OKX 可能返回小数形式
  if (source === 'okx' && Math.abs(value) < 10) {
    return value * 100;
  }
  return value;
}
```

### Win Rate 标准化

```javascript
function normalizeWinRate(value, source) {
  // 确保在 0-100 范围
  if (value > 0 && value <= 1) {
    return value * 100;
  }
  return value;
}
```

### Copiers 统一处理

```javascript
// 统一使用 "当前跟单人数"
// Bitget "累计跟单人数" 存入 total_copiers 字段
```

---

## 八、结论与建议

### 1. 数据完整性排序

1. **Binance** - 最完整（基准）
2. **Bybit** - 非常完整（含 AUM、Sharpe）
3. **Bitget** - 较完整（含平均持仓时长）
4. **MEXC** - 中等（含 Sharpe）
5. **OKX** - 中等（缺少 AUM、Sharpe、交易次数）
6. **GMX** - 最少（无 Win Rate、MDD、Copiers、90D）

### 2. 跨交易所排名建议

- 使用最小公共字段集：`roi`, `pnl`
- 辅助字段 `win_rate`, `max_drawdown` 用于有数据的交易所
- GMX 单独分组或明确标注"数据有限"
- 90D 评分权重需考虑 GMX 仅有 7D/30D

### 3. UI 展示建议

- 缺失字段显示 "N/A" 或 "-"
- 悬浮提示说明数据来源和时间段
- 不同交易所用不同颜色/图标区分
- 跨交易所比较时明确标注数据差异
