# Arena Enrichment Patterns

专属 Arena 项目的数据 enrichment 经验沉淀。

## 核心原则

1. **NEVER fabricate data** — 空 null 比假数据好
2. **CEX API → CF blocked → Puppeteer fallback** — 标准降级链
3. **Upsert 用 ON CONFLICT (source, source_trader_id, season_id)** — 唯一约束
4. **每脚本独立运行，不依赖 master loop** — 可单独 debug

## 已踩坑记录

### 1. Gains Network
- **直连 API**: 429 rate limit（Mac Mini 也会被限）
- **CF Worker**: 必须有 `/gains/leaderboard-all?chain=arbitrum` 路由
- **ROI 计算**: 用 `avgLoss × count_loss` 作为 capital proxy
- **Fix**: 脚本已有直连 → CF fallback，但 CF Worker 需要部署最新版

### 2. Hyperliquid
- **API**: `https://api.hyperliquid.xyz/info` — POST 请求
- **WR/MDD**: 必须从 `userFillsByTime` 算，不能直接取字段
- **坑**: `portfolio` API 返回的 `pnlHistory` 不是 Win Rate
- **最佳实践**: 
  ```javascript
  // WR from fills
  const closed = fills.filter(f => parseFloat(f.closedPnl) !== 0)
  const wins = closed.filter(f => parseFloat(f.closedPnl) > 0).length
  const winRate = (wins / closed.length) * 100
  ```

### 3. dYdX
- **API**: `https://indexer.dydx.trade/v4/historical-pnl`
- **坑**: 大部分地址返回 "no fills" — 可能是链类型不对（v3 vs v4）
- **CF Worker 路由**: `/dydx/historical-pnl?address=xxx`
- **待查**: 需要 `subaccountNumber` 参数吗？

### 4. BitMart / BloFin / BingX
- **BitMart**: CF 1015 拦截 → **必须 Puppeteer**
- **BloFin**: `openapi.blofin.com` — CF Worker 有路由
- **BingX**: REST API 可用，但 CF Worker 路由缺失（404）

### 5. Sharpe/Sortino 计算
- **CEX traders**: 从 ROI + MDD 估算
  ```javascript
  // σ ≈ MDD / 2 (empirical)
  const sharpe = (roi/100) / (mdd/100/2) * sqrt(365/periodDays)
  ```
- **DEX traders**: 从 daily returns 实际算
- **DB 表**: `trader_daily_snapshots` — 需要 backfill 才能用

### 6. CF Worker 部署
- **需要**: `CLOUDFLARE_API_TOKEN` 环境变量
- **命令**: `cd cloudflare-worker && npx wrangler deploy`
- **当前状态**: Worker 健康但路由 404 → 需要重新部署最新代码

## 常用诊断命令

```bash
# 检查数据新鲜度
curl https://www.arenafi.org/api/monitoring/freshness

# 检查某平台的 null 统计
node scripts/diagnose.mjs --source=hyperliquid

# 手动跑 enrichment
node scripts/import/enrich_hyperliquid_full.mjs 30D --resume

# backfill daily snapshots
node scripts/import/backfill_daily_snapshots.mjs --limit=5000
```

## VPS Cron 配置

位置: `/opt/arena/cron_refresh.sh`

```bash
# 主要刷新（每小时）
0 * * * * /opt/arena/cron_refresh.sh major

# 数据新鲜度监控（每2小时）
0 */2 * * * curl -H "Authorization: Bearer $CRON_SECRET" https://www.arenafi.org/api/monitoring/freshness
```

## 更新日志

- 2026-02-23: 创建 skill，记录 Gains/Hyperliquid/dYdX/BitMart 坑点
- 2026-02-23: 添加 CF Worker 部署说明
