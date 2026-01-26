# 数据源设置指南

## 当前状态

| 类型 | 平台数 | 状态 |
|------|--------|------|
| ✅ 活跃 | 12 | 正常工作 |
| ⚠️ 需代理 | 3 | Binance Futures/Spot, KuCoin |
| ❌ 需配置 | 4 | dYdX, Dune (3个) |

## 修复步骤

### 1. 部署 Cloudflare Worker 代理 (修复 Binance/KuCoin)

Binance 和 KuCoin 的 API 会封锁云服务商 IP，需要通过 Cloudflare Worker 代理请求。

```bash
# 1. 登录 Cloudflare (首次需要)
cd cloudflare-worker
npx wrangler login

# 2. 部署 Worker
npx wrangler deploy

# 3. 复制输出的 Worker URL，添加到 .env:
# CLOUDFLARE_PROXY_URL=https://ranking-arena-proxy.<你的账号>.workers.dev

# 4. 测试代理
curl https://ranking-arena-proxy.<你的账号>.workers.dev/health

# 5. 使用代理抓取数据
node scripts/import/import_via_proxy.mjs all ALL
```

### 2. 配置 Dune Analytics API (修复 Dune 数据源)

Dune Analytics 提供链上数据，但需要付费订阅才能使用 API。

**要求:**
- Dune Analyst ($349/月) 或 Plus 计划
- Free 计划无法使用 API

**步骤:**
1. 访问 https://dune.com 并登录
2. 升级到 Analyst 或 Plus 计划
3. 进入 Settings -> API -> Create Key
4. 添加到 .env: `DUNE_API_KEY=your_key`
5. 在 Dune 上创建或查找合适的查询:
   - GMX: 搜索 "GMX trader PnL" 或 "GMX leaderboard"
   - Hyperliquid: 搜索 "Hyperliquid performance"
   - Uniswap: 搜索 "Uniswap LP returns"
6. 设置查询 ID:
   - `DUNE_GMX_QUERY_ID=12345`
   - `DUNE_HYPERLIQUID_QUERY_ID=12345`
   - `DUNE_UNISWAP_QUERY_ID=12345`

### 3. dYdX 数据源

**当前状态:** 不可用

**原因:**
- dYdX v4 没有公开的排行榜 API
- 网页使用复杂的前端框架，无法通过 Puppeteer 抓取
- 官方 Indexer API 只提供单账户数据，无法获取排行榜

**替代方案:**
1. 等待 dYdX 提供官方排行榜 API
2. 使用第三方数据聚合服务
3. 暂时从数据源列表中移除

## 脚本说明

| 脚本 | 用途 |
|------|------|
| `import_via_proxy.mjs` | 通过代理抓取 Binance/KuCoin |
| `import_dune.mjs` | Dune Analytics 链上数据 |
| `test-all-sources.mjs` | 检查所有数据源状态 |
| `deploy-proxy.sh` | 一键部署 Cloudflare Worker |

## 环境变量

```bash
# Cloudflare Worker 代理
CLOUDFLARE_PROXY_URL=https://ranking-arena-proxy.<account>.workers.dev
CLOUDFLARE_PROXY_SECRET=optional-secret

# Dune Analytics
DUNE_API_KEY=your_dune_api_key
DUNE_GMX_QUERY_ID=12345
DUNE_HYPERLIQUID_QUERY_ID=12345
DUNE_UNISWAP_QUERY_ID=12345
```

## 验证数据

```bash
# 检查所有数据源状态
node scripts/test-all-sources.mjs

# 检查排行榜 API
curl "http://localhost:3000/api/rankings?period=30D&limit=10"
```
