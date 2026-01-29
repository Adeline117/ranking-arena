# Puppeteer Worker 方案对比 / Puppeteer Worker Architecture Plan

> 最后更新 / Last updated: 2025-07-15

## 背景 / Background

Ranking Arena 需要定时抓取交易所排行榜数据。部分交易所（如 Binance、Bybit、Bitget）的跟单排行榜需要浏览器渲染才能获取完整数据，简单的 HTTP 请求无法绕过反爬或 JS 渲染保护。

Some exchanges require browser-based scraping for leaderboard data (JS-rendered pages, anti-bot protection). This document compares four architectures for running Puppeteer/Playwright workers.

---

## 方案对比 / Architecture Comparison

| 维度 Dimension | ① 本地 Cron<br>Local Cron | ② CF Browser Rendering<br>Cloudflare Browser | ③ VPS + Playwright<br>Dedicated VPS | ④ Browserless.io<br>Cloud Browser API |
|---|---|---|---|---|
| **架构 Architecture** | 本地/CI 机器跑 cron job，Playwright headless | Cloudflare Workers + Browser Rendering API (beta) | 独立 VPS (Hetzner/Vultr) 运行 Playwright | Browserless SaaS，WebSocket 连接 |
| **成本 Cost/mo** | $0 (本地) / $5-15 (GitHub Actions) | $0 free tier (限 Workers KV 读写) → ~$5-25 paid | $4-8 (Hetzner CX22) | $0 free 1000 sessions → $50+ 超量 |
| **稳定性 Stability** | ⭐⭐ 依赖本地 uptime | ⭐⭐⭐ CF edge 网络，但 Browser API 仍 beta | ⭐⭐⭐⭐ 全控，可监控 | ⭐⭐⭐⭐ 托管服务，自动扩容 |
| **维护成本 Maintenance** | 低 | 中（需适配 CF Workers 限制） | 中（需管理服务器、更新浏览器） | 极低（SaaS） |
| **IP 质量 IP Quality** | 家庭 IP ⭐⭐⭐⭐ | CF edge IP ⭐⭐⭐ | 数据中心 IP ⭐⭐ (可加代理) | 数据中心 IP ⭐⭐ (可配代理) |
| **并发 Concurrency** | 受限于机器资源 (2-4) | Workers 并发高，但每 req ≤30s | 取决于 VPS 配置 (4-8) | 按计划扩容 (10-50+) |
| **冷启动 Cold Start** | 无（cron 直接执行） | ~2-5s (Browser spin-up) | 无（常驻进程） | ~1-3s (session 创建) |
| **地理限制 Geo** | 受限于本地网络 | 全球 edge | 选择机房位置 | 多地区可选 |
| **数据持久化 Persistence** | 本地文件 / 直接写 Supabase | KV / R2 / 直接写 Supabase | 直接写 Supabase | 通过回调写 Supabase |

---

## 详细方案 / Detailed Plans

### ① 本地 Cron (当前方案 / Current Setup)

**目录:** `worker/`

```
worker/
├── src/
│   ├── scrapers/          # Playwright 爬虫
│   │   ├── base.ts
│   │   ├── binance-futures.ts
│   │   ├── binance-spot.ts
│   │   ├── bybit.ts
│   │   └── bitget-futures.ts
│   ├── job-runner/        # 调度器
│   ├── db.ts              # Supabase 写入
│   └── cli.ts             # 命令行入口
├── Dockerfile
└── tsconfig.json
```

**优点 Pros:**
- 零成本，开发/调试方便
- 家庭 IP 通常不被交易所封锁
- 已实现，代码成熟

**缺点 Cons:**
- 依赖本地机器 uptime
- 不适合生产环境
- 无法自动恢复

**推荐场景:** 开发/测试阶段

---

### ② Cloudflare Browser Rendering

**目录:** `cloudflare-worker/`

**当前状态:** CF Worker 已用于 API 代理（绕过地区封锁），但 Browser Rendering API 仍是 beta。

```
cloudflare-worker/
├── src/
│   └── index.ts           # 已有 API 代理
├── wrangler.toml
└── package.json
```

**扩展方案:**
```typescript
// wrangler.toml 新增
[browser]
binding = "BROWSER"

// 新增 scrape 端点
if (url.pathname === '/scrape/binance') {
  const browser = await env.BROWSER.open();
  const page = await browser.newPage();
  await page.goto('https://www.binance.com/en/copy-trading');
  // ... 爬取逻辑
}
```

**优点 Pros:**
- 与现有 CF Worker 代理合并，统一架构
- CF edge 网络，全球分布
- 自动扩容，免运维

**缺点 Cons:**
- Browser Rendering API 目前 beta，功能有限
- 每次请求最多 30s (Workers 限制)
- 不支持完整 Playwright API
- 复杂页面交互困难

**推荐场景:** 简单页面抓取，等 API 稳定后迁移

---

### ③ VPS + Playwright (推荐生产方案 / Recommended)

**成本:** Hetzner CX22 ~€4/mo (2 vCPU, 4GB RAM)

```
ranking-arena-worker/     # 独立仓库或 worker/ 目录
├── src/
│   ├── scrapers/         # Playwright 爬虫
│   ├── connectors/       # HTTP API 连接器
│   ├── scheduler.ts      # Cron 调度器 (node-cron)
│   ├── health.ts         # 健康检查 HTTP server
│   └── index.ts
├── Dockerfile
├── docker-compose.yml
└── .env
```

**部署:**
```yaml
# docker-compose.yml
services:
  worker:
    build: .
    restart: always
    environment:
      - SUPABASE_URL=...
      - SUPABASE_KEY=...
      - DYDX_PROXY_URL=https://ranking-arena-proxy.YOUR.workers.dev
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 60s
```

**优点 Pros:**
- 完全控制运行环境
- 支持完整 Playwright API + 长时间运行
- 可添加代理轮换 (residential proxy)
- 成本极低 (~$5/mo)
- 可监控、告警

**缺点 Cons:**
- 需要管理服务器 (OS 更新、浏览器更新)
- 数据中心 IP 可能被封 (可加代理)

**推荐场景:** ✅ 生产环境首选

---

### ④ Browserless.io

**成本:** Free tier 1000 sessions/mo → $50/mo for 10k sessions

```typescript
import { chromium } from 'playwright-core'

const browser = await chromium.connectOverCDP(
  'wss://chrome.browserless.io?token=YOUR_TOKEN'
)
```

**优点 Pros:**
- 零运维，即开即用
- 自动管理浏览器实例
- 内置代理、session 管理
- 支持并发扩容

**缺点 Cons:**
- 成本随量增长快
- 依赖第三方 SaaS
- 网络延迟

**推荐场景:** 快速原型验证 / 高并发需求

---

## 推荐架构 / Recommended Architecture

```
┌─────────────────┐     ┌──────────────────────┐
│  Next.js App    │────▶│  Supabase (DB)       │
│  (Vercel)       │     │  - traders           │
└─────────────────┘     │  - snapshots         │
                        │  - leaderboard_cache │
┌─────────────────┐     └──────────────────────┘
│  VPS Worker     │────▶       ▲
│  (Hetzner)      │            │
│  - Playwright   │     ┌──────┴───────────────┐
│  - Cron jobs    │     │  CF Worker Proxy     │
│  - HTTP API     │────▶│  (ranking-arena-     │
│    connectors   │     │   proxy.workers.dev) │
└─────────────────┘     │  - API proxy         │
                        │  - dYdX bypass       │
                        │  - IP pool           │
                        └──────────────────────┘
```

**阶段路线图 / Phased Rollout:**

| 阶段 Phase | 方案 Approach | 平台覆盖 Coverage |
|---|---|---|
| P0 (现在 Now) | 本地 cron + CF Worker API 代理 | HTTP API 交易所 (dYdX, Hyperliquid, GMX) |
| P1 (1-2周) | VPS Worker (Hetzner) | + Binance/Bybit/Bitget 浏览器爬取 |
| P2 (1月后) | VPS + residential proxy | + 反爬保护强的交易所 |
| P3 (视需要) | CF Browser Rendering | 简单页面迁移到 edge |

---

## 成本汇总 / Cost Summary

| 组件 Component | 月成本 Monthly Cost |
|---|---|
| Vercel (Next.js) | $0 (hobby) / $20 (pro) |
| Supabase | $0 (free) / $25 (pro) |
| CF Worker Proxy | $0 (free tier) / $5 (paid) |
| VPS (Hetzner CX22) | ~$5 |
| Residential Proxy (可选) | $0-30 |
| **总计 Total** | **$5-85/mo** |

MVP 阶段推荐: **$5/mo** (Supabase free + CF Worker free + Hetzner CX22)
