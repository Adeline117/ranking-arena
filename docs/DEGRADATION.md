# Degradation Strategy

每个外部依赖挂掉时的降级行为。

## 核心服务

### Supabase (PostgreSQL + Auth)
- **影响**: 所有数据读写、用户认证
- **降级**:
  - 读请求: Redis 缓存命中则返回缓存数据（leaderboard、trader details 有缓存层）
  - 写请求: 返回 503 + 友好提示"服务暂时不可用，请稍后重试"
  - Auth: 返回 401，前端显示"登录服务暂时不可用"
- **告警**: Telegram 即时通知（24h Redis 去重）+ Sentry error
- **恢复**: 自动恢复，无需人工干预

### Upstash Redis
- **影响**: 缓存层、限流、session、Telegram 告警去重
- **降级**:
  - 缓存 miss: 直接查 Supabase（性能下降但功能正常）
  - 限流失效: 放行所有请求（宁可不限流也不拒绝服务）
  - 告警去重失效: 可能重复发送 Telegram 告警（可接受）
  - 实现: `lib/cache/redis.ts` 已有 try/catch fallback
- **告警**: Telegram 通知
- **恢复**: 自动恢复

### Stripe
- **影响**: 订阅支付、Pro 会员
- **降级**:
  - Checkout: 显示"支付服务暂时不可用，请稍后重试"
  - Webhook: Stripe 自动重试（最多 3 天）
  - 已有订阅: 不受影响（基于本地 subscription 表）
- **告警**: Sentry error
- **恢复**: Webhook 自动重试补发事件

### Sentry
- **影响**: 错误监控
- **降级**: 静默失败，不影响用户功能
- **实现**: `lib/middleware/error-interceptor.ts` 动态 import，失败不抛错
- **恢复**: 自动恢复

## 数据管道

### Exchange API (任意交易所)
- **影响**: 该交易所的 trader 数据不更新
- **降级**:
  - Circuit breaker 自动熔断（`lib/connectors/circuit-breaker.ts`）
  - 5 次连续失败 → 熔断 5 分钟 → 半开状态探测
  - 前端显示最后一次成功抓取的数据 + "数据更新时间: X 分钟前"
  - 其他交易所不受影响
  - Pre-upsert degradation check 防止部分抓取覆盖完整数据
- **告警**: `check-data-freshness` cron 检测 → Telegram 告警（24h 去重，severity 路由）
- **恢复**: Circuit breaker 自动半开 → 探测成功 → 恢复

### VPS Scraper (SG VPS 45.76.152.169)
- **影响**: WAF-blocked 平台的数据获取（Bybit, Bitget, Gate.io, MEXC, CoinEx, BingX, BloFin）
- **降级**:
  - 各 connector 有多层 strategy fallback（direct API → VPS scraper → CF Worker）
  - 路由优先级配置: `lib/connectors/route-config.ts`
  - 如 VPS 完全不可用，仅影响 WAF-blocked 平台，其他平台不受影响
- **告警**: Telegram 通知
- **恢复**: 需 SSH 到 VPS 检查 `systemctl status arena-proxy` / PM2 进程

### Cloudflare Worker (地理封锁代理)
- **影响**: Binance/OKX 等被墙交易所的 API 访问
- **降级**:
  - Smart routing 优先使用 VPS proxy，CF Worker 作为 fallback
  - 如两者都不可用，直连尝试（可能因地理封锁失败）
  - 返回缓存数据
- **告警**: Telegram 通知
- **恢复**: 需要检查 CF Worker 状态

### Coingecko API (市场数据)
- **影响**: 币价、市场概览
- **降级**: 返回缓存的最后市场数据
- **告警**: 日志 warn
- **恢复**: 自动恢复

## Cron 作业

### 任何 Cron 失败
- **行为**: PipelineLogger 记录失败 → `pipeline_job_logs` 表
- **告警**:
  - `check-data-freshness` 每 30 分钟检查 → 超时告警
  - OpenClaw 健康监控（每 30 分钟）→ Telegram 通知
  - 每日 digest 汇总（8 AM）
- **恢复**: 下次调度自动重试

### batch-fetch-traders 失败
- **影响**: 排行榜数据不更新
- **降级**: 前端显示缓存数据，带时间戳；72h 内数据仍参与 composite score 计算
- **恢复**: 下次 cron 自动重试
- **分组**: A/A2/B/C/D1/D2/E/F/H/G1/G2/I（每组 ≤3 平台，≤2 并行）

### batch-enrich 失败
- **影响**: trader 详情不更新（7D/30D 数据）
- **降级**: 显示已有的 enrichment 数据
- **实现**: `lib/cron/enrichment-runner.ts` inline 执行（无 HTTP 子调用）
- **恢复**: 下次 cron 自动重试

### compute-leaderboard 失败
- **影响**: Arena Score 不更新
- **降级**: 使用上次计算的分数；72h freshness filter 防止过期数据污染
- **恢复**: 下次 cron 自动重试

## 前端降级

### 网络断开
- `NetworkStatusBanner` 组件显示离线提示
- 已加载的页面数据保留可见

### API 超时
- 所有 fetch 有 timeout（默认 30s，connector 10s）
- 超时返回缓存数据或友好错误提示
- 用户可点击 Retry 按钮重试

### CDN 资源加载失败
- 图片: `onError` fallback 到默认头像/placeholder（wallet address 使用 blockie SVG）
- 字体: 系统字体 fallback
- JS chunk: Next.js 自动重试

## 已停用平台（Dead / Blocked）
以下平台已从活跃 cron 组中移除，不再抓取数据：
- KuCoin: API 404, feature discontinued
- LBank: Session auth required, browser crashes
- BitMart: copytrade API "service not open"
- Synthetix: Copin stale since Sep 2025
- MUX: THEGRAPH_API_KEY required
- WhiteBit/BTSE: No public leaderboard API
- dYdX: Migrated to Heroku + Copin fallback
- Paradex: JWT auth required since 2026-03

## 监控仪表盘
- `/admin/monitoring` - 系统健康概览
- `/admin/pipeline` - 数据管道状态
- `/api/health/pipeline` - OpenClaw 健康检查 API
- `scripts/pipeline-health-check.mjs` - CLI 全面健康检查
- `scripts/pipeline-report.ts` - 快速诊断报告
