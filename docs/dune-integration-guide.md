# Dune Analytics 数据导入指南

## 概述

本指南介绍如何将 Dune Analytics 作为完整的排行榜数据源，导入 DEX 永续合约、现货交易、DeFi 钱包活动等链上交易员数据。

---

## 第一步：了解 Dune API 计费与限制

### Credits 体系

Dune 采用 **credits（积分）** 计费，按实际计算资源消耗扣除，**不是**按查询次数或行数计费。

| Plan | 月费 | 月度 Credits | API 访问 |
|------|------|-------------|----------|
| Free | $0 | 2,500 | ❌ 不支持 |
| Analyst | $349/月 | 4,000 | ✅ 支持 |
| Plus | $349/月 | 25,000 | ✅ 支持 |
| Plus (年付) | ~$2,800/年 | 25,000/月 | ✅ 支持 |

**重要**：
- **Free 计划无法使用 API**，只能在网页手动执行查询
- 要实现自动化数据导入，**必须升级到 Analyst 或 Plus**
- Credits 消耗取决于查询复杂度、扫描数据量、执行引擎类型

### Rate Limits（速率限制）

| 限制类型 | 限制值 |
|---------|-------|
| 并发执行 | 最多 3 个查询同时执行 |
| 请求频率 | 约 60 requests/minute |
| 单次结果 | 默认 1000 行，可通过 `limit` 参数调整 |

### Pagination（分页）

- 默认返回 1000 行
- 使用 `limit` 和 `offset` 参数分页获取更多数据
- 示例：`/results?limit=500&offset=0`，然后 `offset=500` 获取下一页

**参考文档**：
- [Credit System](https://docs.dune.com/api-reference/overview/credit-system)
- [Rate Limits](https://docs.dune.com/api-reference/overview/rate-limits)
- [Pagination](https://docs.dune.com/api-reference/overview/pagination)

---

## 第二步：获取 Dune API Key

1. 访问 https://dune.com/settings/api
2. 登录账号（需 Analyst 或 Plus 计划）
3. 点击 "Create new API key"
4. 复制 API Key，妥善保管

---

## 第三步：在 Dune 上创建并验证 SQL 查询

### 重要：先验证表和字段

**在写复杂聚合查询前，务必先确认表和字段存在**：

1. 打开 Dune，使用 Data Explorer 搜索表名
2. 运行简单查询确认字段：
   ```sql
   SELECT * FROM <table_name> LIMIT 10
   ```
3. 确认字段名、数据类型后再写聚合查询

### 3.1 GMX 查询（Arbitrum）

**先验证表存在**：
```sql
-- 先确认表和字段
SELECT * FROM gmx_v2_arbitrum.position_decrease LIMIT 10
```

**正式查询**（ROI 计算说明见下方）：
```sql
SELECT
  account as address,
  SUM(realized_pnl_usd) as total_pnl,
  -- 近似 ROI：PnL / 总保证金，需注意小分母问题
  CASE
    WHEN SUM(ABS(collateral_delta_usd)) > 100
    THEN SUM(realized_pnl_usd) / SUM(ABS(collateral_delta_usd)) * 100
    ELSE NULL
  END as roi_pct,
  COUNT(*) as trade_count,
  SUM(CASE WHEN realized_pnl_usd > 0 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as win_rate
FROM gmx_v2_arbitrum.position_decrease
WHERE block_time > NOW() - INTERVAL '{{days}} days'
  AND realized_pnl_usd IS NOT NULL
GROUP BY account
HAVING COUNT(*) >= 5
  AND SUM(ABS(collateral_delta_usd)) > 100  -- 最小保证金阈值，过滤异常数据
ORDER BY total_pnl DESC
LIMIT 500
```

**注意**：
- 表名可能是 `gmx_v2_arbitrum.position_decrease` 或其他，请在 Dune 搜索确认
- `roi_pct` 是**近似值**，计算方式为 `PnL / 保证金`，不同于 CEX 的标准 ROI
- 添加了 `SUM(ABS(collateral_delta_usd)) > 100` 阈值，避免小额交易产生极端 ROI

### 3.2 Hyperliquid 查询

**先验证表存在**：
```sql
-- Hyperliquid 可能在不同的 schema，先搜索确认
SELECT * FROM hyperliquid.trades LIMIT 10
-- 或者
SELECT * FROM dex_perp.trades WHERE project = 'hyperliquid' LIMIT 10
```

**正式查询**（根据实际表结构调整）：
```sql
SELECT
  user_address as address,
  SUM(pnl) as total_pnl,
  CASE
    WHEN SUM(ABS(margin)) > 100
    THEN SUM(pnl) / SUM(ABS(margin)) * 100
    ELSE NULL
  END as roi_pct,
  COUNT(*) as trade_count,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as win_rate
FROM hyperliquid.trades  -- 确认实际表名
WHERE block_time > NOW() - INTERVAL '{{days}} days'
GROUP BY user_address
HAVING COUNT(*) >= 5
  AND SUM(ABS(margin)) > 100
ORDER BY total_pnl DESC
LIMIT 500
```

### 3.3 Uniswap 查询（DEX Spot）

**先验证**：
```sql
SELECT * FROM dex.trades WHERE project = 'uniswap' LIMIT 10
```

**正式查询**：
```sql
SELECT
  taker as address,  -- 字段名可能是 taker, trader, tx_from 等
  SUM(amount_usd) as total_volume,
  COUNT(*) as swap_count,
  COUNT(DISTINCT token_bought_address) as tokens_traded
FROM dex.trades
WHERE project = 'uniswap'
  AND block_time > NOW() - INTERVAL '{{days}} days'
  AND amount_usd > 0
GROUP BY taker
HAVING SUM(amount_usd) > 10000  -- 最小交易量阈值
ORDER BY total_volume DESC
LIMIT 500
```

**注意**：Uniswap 是现货 DEX，**没有 PnL/ROI 概念**，只能按交易量排名。

### 3.4 DeFi 活跃钱包查询

**先验证表存在**：
```sql
-- crosschain.transactions 可能不存在，需要找替代表
-- 可以尝试组合多个协议的表
SELECT * FROM aave_v3_ethereum.borrow LIMIT 10
SELECT * FROM uniswap_v3_ethereum.trades LIMIT 10
```

**示例查询**（需根据实际可用表调整）：
```sql
WITH defi_activity AS (
  SELECT tx_from as address, 'aave' as protocol, amount_usd
  FROM aave_v3_ethereum.borrow
  WHERE block_time > NOW() - INTERVAL '{{days}} days'

  UNION ALL

  SELECT taker as address, 'uniswap' as protocol, amount_usd
  FROM dex.trades
  WHERE project = 'uniswap' AND block_time > NOW() - INTERVAL '{{days}} days'

  -- 添加更多协议...
)
SELECT
  address,
  COUNT(DISTINCT protocol) as protocols_used,
  SUM(amount_usd) as total_volume,
  COUNT(*) as tx_count
FROM defi_activity
WHERE amount_usd > 0
GROUP BY address
HAVING COUNT(DISTINCT protocol) >= 2
  AND SUM(amount_usd) > 1000
ORDER BY total_volume DESC
LIMIT 500
```

---

## 第四步：ROI 计算口径说明

### 当前实现的局限性

我们的 ROI 计算公式是：
```
ROI = SUM(realized_pnl) / SUM(ABS(collateral_delta)) * 100
```

**已知问题**：
1. **小分母放大效应**：保证金很小的交易会产生极端 ROI
2. **资金使用方式差异**：高杠杆 vs 低杠杆交易员无法公平比较
3. **不是真正的账户 ROI**：链上数据无法获取账户总资产

**缓解措施**：
- 添加最小保证金阈值：`HAVING SUM(ABS(collateral_delta)) > 100`
- 在 UI 显示时标注"近似 ROI"
- 考虑使用 Arena Score 综合排名，而非单一 ROI

### 排名逻辑说明

当前 `ORDER BY total_pnl DESC` 会导致：
- **本金大、交易频繁**的人系统性排在前面
- 不一定反映交易技能（skill-based ranking）

**可选优化方向**：
1. 按 ROI 排名（风险：小额交易极端值）
2. 按 Sharpe Ratio 排名（需要每日收益数据）
3. 使用 Arena Score 综合评分（当前推荐）

---

## 第五步：配置环境变量

在 `.env.local` 中添加：

```bash
# Dune API Key（必须是 Analyst 或 Plus 计划）
DUNE_API_KEY=your_api_key_here

# 查询 ID（在 Dune 保存查询后从 URL 获取）
# 例如 https://dune.com/queries/1234567 中的 1234567
DUNE_GMX_QUERY_ID=
DUNE_HYPERLIQUID_QUERY_ID=
DUNE_UNISWAP_QUERY_ID=
DUNE_DEFI_QUERY_ID=
```

---

## 第六步：运行导入脚本

```bash
# 导入所有平台（有 Query ID 的）
node scripts/import/import_dune.mjs

# 只导入 GMX
node scripts/import/import_dune.mjs gmx

# 只导入 GMX 30 天数据
node scripts/import/import_dune.mjs gmx 30D
```

---

## 第七步：验证数据

### 检查数据库
```sql
SELECT source, season_id, COUNT(*), AVG(roi), MAX(roi), MIN(roi)
FROM trader_snapshots
WHERE source LIKE 'dune_%'
GROUP BY source, season_id;
```

### 检查异常值
```sql
-- 检查是否有极端 ROI 值
SELECT * FROM trader_snapshots
WHERE source LIKE 'dune_%'
  AND (roi > 10000 OR roi < -100)
ORDER BY roi DESC;
```

### 检查 API
```
GET /api/rankings?window=30d&platform=dune_gmx
```

---

## 常见问题排查

### Q: 报错 "table not found" 或 "column not found"
**A**: Dune 的表名和字段名经常变化。
1. 在 Dune Data Explorer 搜索相关表
2. 先运行 `SELECT * FROM <table> LIMIT 10` 确认字段
3. 更新 SQL 中的表名和字段名

### Q: API 返回 401 Unauthorized
**A**:
- 确认你的计划是 Analyst 或 Plus（Free 无法用 API）
- 确认 API Key 正确，没有多余空格
- 重启开发服务器刷新环境变量

### Q: Credits 消耗太快
**A**:
- 使用 `fetchCachedResults()` 优先获取缓存结果
- 减少查询频率（建议每 4-6 小时一次）
- 优化 SQL 减少扫描数据量

### Q: 榜单被异常数据污染
**A**:
- 增加 `HAVING` 子句的阈值
- 在导入脚本中添加数据校验
- 考虑排除极端值（如 ROI > 10000%）

### Q: 数据延迟
**A**: Dune 链上数据通常有 10-30 分钟延迟，这是正常的。在 UI 显示数据时间戳提示用户。

---

## 参考链接

- [Dune API 文档](https://docs.dune.com/api-reference)
- [Credit System](https://docs.dune.com/api-reference/overview/credit-system)
- [Rate Limits](https://docs.dune.com/api-reference/overview/rate-limits)
- [GMX 官方 Dune Dashboard](https://dune.com/gmx-io/gmx-analytics)
- [Hyperliquid Dune 数据](https://dune.com/hyperliquid)
