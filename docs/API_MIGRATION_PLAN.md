# 排行榜数据源迁移计划
## 从网页爬虫到官方API的渐进式迁移方案

**文档版本**: v1.0
**创建日期**: 2026-02-06
**预计完成**: 2026-05-30 (16周)
**负责人**: Tech Team

---

## 📋 目录

1. [执行摘要](#执行摘要)
2. [当前架构分析](#当前架构分析)
3. [官方API研究](#官方api研究)
4. [目标架构设计](#目标架构设计)
5. [分阶段迁移计划](#分阶段迁移计划)
6. [风险管理](#风险管理)
7. [成本分析](#成本分析)
8. [成功指标](#成功指标)

---

## 🎯 执行摘要

### 迁移目标
将当前基于 Playwright 网页爬虫的数据获取方式，逐步迁移到使用交易所官方 API，以提升：
- **数据质量**: 官方数据源，准确性100%
- **系统稳定性**: 减少页面变更导致的中断
- **合规性**: 符合交易所ToS，降低封禁风险
- **实时性**: API响应速度 < 100ms (vs 爬虫 2-5秒)
- **成本效率**: 减少代理费用和维护成本

### 关键时间线
- **Phase 1** (Week 1-4): 顶级交易所API迁移 (Binance, Bybit, OKX)
- **Phase 2** (Week 5-8): 中型交易所API迁移 (Bitget, Gate.io, MEXC)
- **Phase 3** (Week 9-12): 小型CEX + 链上DEX API迁移
- **Phase 4** (Week 13-16): 优化、监控、文档完善

---

## 📊 当前架构分析

### 支持的交易所列表 (35个)

#### Tier 1: 顶级CEX (官方API优先级最高)
1. **Binance** (binance_futures, binance_spot, binance_web3)
2. **Bybit** (bybit, bybit_spot)
3. **OKX** (okx_futures, okx_web3)
4. **Bitget** (bitget_futures, bitget_spot)
5. **Gate.io** (gateio)

#### Tier 2: 中型CEX
6. **MEXC** (mexc)
7. **KuCoin** (kucoin)
8. **HTX/Huobi** (htx)
9. **BingX** (bingx)
10. **CoinEx** (coinex)
11. **Phemex** (phemex)
12. **XT.com** (xt)
13. **Pionex** (pionex)
14. **LBank** (lbank)
15. **BloFin** (blofin)
16. **WEEx** (weex)

#### Tier 3: 链上DEX (优先使用The Graph/链上API)
17. **GMX** (Arbitrum)
18. **Hyperliquid** (L1)
19. **dYdX** (dydx v4)
20. **Vertex Protocol** (vertex)
21. **Drift Protocol** (Solana)
22. **Jupiter Perps** (Solana)
23. **Kwenta** (Optimism - Synthetix)
24. **Synthetix** (synthetix)
25. **Gains Network** (gains)
26. **MUX Protocol** (mux)
27. **Aevo** (aevo)

### 当前抓取方式

```typescript
// worker/src/scrapers/base.ts
export abstract class BaseScraper {
  protected page?: Page
  protected browser?: Browser

  // 使用 Playwright 拦截网络请求
  page.on('response', (response) => {
    if (response.url().includes('/api/copy-trading')) {
      const data = await response.json()
      // 解析交易员数据
    }
  })
}
```

**当前流程**:
1. Playwright 打开浏览器
2. 访问交易所跟单页面
3. 拦截 XHR/Fetch 请求
4. 解析响应获取交易员列表
5. 存储到 Supabase

**痛点**:
- ❌ 页面DOM变更导致爬虫失效
- ❌ 需要大量代理IP轮换
- ❌ Playwright实例占用大量内存
- ❌ 响应速度慢 (2-5秒/请求)
- ❌ 违反部分交易所ToS
- ❌ 容易被检测和封禁

---

## 🔑 官方API研究

### API可用性矩阵

| 交易所 | 官方API | 跟单数据 | 限流 | 认证 | 文档质量 | 迁移优先级 |
|--------|---------|----------|------|------|----------|-----------|
| **Binance** | ✅ | ✅ | 2400/min | API Key | ⭐⭐⭐⭐⭐ | P0 |
| **Bybit** | ✅ | ✅ | 120/s | API Key | ⭐⭐⭐⭐⭐ | P0 |
| **OKX** | ✅ | ✅ | 20/2s | API Key | ⭐⭐⭐⭐ | P0 |
| **Bitget** | ✅ | ✅ | 20/s | API Key | ⭐⭐⭐⭐ | P1 |
| **Gate.io** | ✅ | ✅ | 900/s | API Key | ⭐⭐⭐⭐ | P1 |
| **MEXC** | ✅ | ❓ | 20/s | API Key | ⭐⭐⭐ | P1 |
| **KuCoin** | ✅ | ❓ | 30/3s | API Key | ⭐⭐⭐ | P1 |
| **HTX** | ✅ | ❓ | 100/10s | API Key | ⭐⭐ | P2 |
| **BingX** | ✅ | ❓ | Varies | API Key | ⭐⭐ | P2 |
| **GMX** | The Graph | ✅ | 1000/day (free) | None | ⭐⭐⭐⭐⭐ | P0 |
| **Hyperliquid** | ✅ | ✅ | Unlimited | None | ⭐⭐⭐⭐⭐ | P0 |
| **dYdX v4** | ✅ | ✅ | Unlimited | None | ⭐⭐⭐⭐⭐ | P0 |
| **Jupiter** | ✅ | ✅ | RPC限制 | None | ⭐⭐⭐⭐ | P1 |
| **Drift** | ✅ | ✅ | RPC限制 | None | ⭐⭐⭐⭐ | P1 |

### 顶级交易所API详情

#### 1. Binance Copy Trading API

**端点**: `GET /sapi/v1/copyTrading/futures/userPerformance`

```bash
# 获取跟单交易员列表
GET https://api.binance.com/sapi/v1/copyTrading/futures/leadUserPerformance
Headers:
  X-MBX-APIKEY: {api_key}
Params:
  period: 7D | 30D | 90D
  sortBy: roi | pnl | followers
  limit: 100
```

**响应示例**:
```json
{
  "data": [{
    "encryptedUid": "trader_id_encrypted",
    "roi": "125.50",
    "pnl": "50000.00",
    "followers": 1500,
    "maxDrawDown": "12.5",
    "winRate": "65.5",
    "tradeCount": 150,
    "aum": "2500000.00"
  }]
}
```

**限流**: 2400请求/分钟 (Weight based)
**认证**: HMAC SHA256签名
**文档**: https://binance-docs.github.io/apidocs/futures/en/

---

#### 2. Bybit Copy Trading API

**端点**: `GET /v5/copytrading/trader-list`

```bash
GET https://api.bybit.com/v5/copytrading/trader-list
Headers:
  X-BAPI-API-KEY: {api_key}
  X-BAPI-TIMESTAMP: {timestamp}
  X-BAPI-SIGN: {signature}
Params:
  sortBy: pnl | roi | followerNum
  timeWindow: 7D | 30D | 90D
  limit: 100
```

**限流**: 120请求/秒
**认证**: HMAC SHA256
**文档**: https://bybit-exchange.github.io/docs/v5/copy-trading/trader-list

---

#### 3. OKX Copy Trading API

**端点**: `GET /api/v5/copytrading/public-lead-traders`

```bash
GET https://www.okx.com/api/v5/copytrading/public-lead-traders
Headers:
  OK-ACCESS-KEY: {api_key}
  OK-ACCESS-SIGN: {signature}
  OK-ACCESS-TIMESTAMP: {timestamp}
Params:
  instType: SWAP
  sortType: pnl | followNum | roi
  period: 7D | 30D | 90D
```

**限流**: 20请求/2秒
**认证**: RSA签名
**文档**: https://www.okx.com/docs-v5/en/#copy-trading-get-lead-traders

---

#### 4. Hyperliquid API (链上)

**端点**: `POST https://api.hyperliquid.xyz/info`

```bash
POST https://api.hyperliquid.xyz/info
Body:
{
  "type": "leaderboard",
  "leaderboardType": "pnl",
  "timeframe": "day" | "week" | "month"
}
```

**优势**:
- ✅ 无需认证
- ✅ 无限流限制
- ✅ 实时链上数据
- ✅ 100% 透明

**文档**: https://hyperliquid.gitbook.io/hyperliquid-docs/

---

#### 5. GMX (The Graph Subgraph)

**Subgraph**: `https://api.thegraph.com/subgraphs/name/gmx-io/gmx-stats`

```graphql
query GetTopTraders {
  traders(
    first: 100
    orderBy: totalPnl
    orderDirection: desc
    where: { period: "7d" }
  ) {
    id
    address
    totalPnl
    winRate
    totalVolume
    trades
  }
}
```

**限流**: 免费版1000请求/天，付费版无限制
**成本**: $0 (免费) 或 $100-500/月 (Subgraph Studio)

---

## 🏗️ 目标架构设计

### 新架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                     Vercel Cron Jobs                         │
│                (每4小时触发数据更新)                          │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Exchange Adapter Layer (新)                     │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Binance API  │  │  Bybit API   │  │   OKX API    │      │
│  │   Adapter    │  │   Adapter    │  │   Adapter    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  The Graph   │  │ Hyperliquid  │  │  dYdX API    │      │
│  │   Adapter    │  │   Adapter    │  │   Adapter    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                  Data Normalization Layer                    │
│                (统一数据格式转换)                             │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                     Rate Limiter                             │
│              (Upstash Redis 限流控制)                        │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                  Supabase Database                           │
│                  trader_snapshots                            │
│                trader_daily_snapshots                        │
└─────────────────────────────────────────────────────────────┘
```

### 核心组件设计

#### 1. Exchange Adapter Interface

```typescript
// lib/adapters/base-adapter.ts
export interface ExchangeAdapter {
  name: string
  type: 'cex' | 'dex'

  // 获取交易员排行榜
  getLeaderboard(params: {
    period: '7D' | '30D' | '90D'
    sortBy: 'roi' | 'pnl' | 'followers'
    limit: number
  }): Promise<TraderData[]>

  // 获取单个交易员详情
  getTraderDetails(traderId: string): Promise<TraderDetails>

  // 检查API健康状态
  healthCheck(): Promise<boolean>

  // 获取限流信息
  getRateLimitInfo(): RateLimitInfo
}

export interface TraderData {
  traderId: string
  nickname?: string
  roi: number
  pnl: number
  maxDrawdown: number
  winRate: number
  followers: number
  aum: number
  tradeCount: number
  period: '7D' | '30D' | '90D'
}
```

---

#### 2. Binance Adapter 实现

```typescript
// lib/adapters/binance-adapter.ts
import { createHmac } from 'crypto'
import { ExchangeAdapter, TraderData } from './base-adapter'
import { rateLimit } from '@/lib/ratelimit'

export class BinanceAdapter implements ExchangeAdapter {
  name = 'binance'
  type = 'cex' as const

  private apiKey = process.env.BINANCE_API_KEY!
  private apiSecret = process.env.BINANCE_API_SECRET!
  private baseUrl = 'https://api.binance.com'

  private generateSignature(queryString: string): string {
    return createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex')
  }

  async getLeaderboard(params: {
    period: '7D' | '30D' | '90D'
    sortBy: 'roi' | 'pnl' | 'followers'
    limit: number
  }): Promise<TraderData[]> {
    // 限流控制
    await rateLimit.check('binance', 10) // 10 req/sec

    const timestamp = Date.now()
    const queryString = `period=${params.period}&sortBy=${params.sortBy}&limit=${params.limit}&timestamp=${timestamp}`
    const signature = this.generateSignature(queryString)

    const response = await fetch(
      `${this.baseUrl}/sapi/v1/copyTrading/futures/leadUserPerformance?${queryString}&signature=${signature}`,
      {
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      }
    )

    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status}`)
    }

    const data = await response.json()

    // 数据标准化
    return data.data.map(trader => ({
      traderId: trader.encryptedUid,
      nickname: trader.nickName,
      roi: parseFloat(trader.roi),
      pnl: parseFloat(trader.pnl),
      maxDrawdown: parseFloat(trader.maxDrawDown),
      winRate: parseFloat(trader.winRate),
      followers: trader.followers,
      aum: parseFloat(trader.aum),
      tradeCount: trader.tradeCount,
      period: params.period,
    }))
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v3/ping`)
      return response.ok
    } catch {
      return false
    }
  }

  getRateLimitInfo() {
    return {
      limit: 2400,
      window: '1m',
      remaining: 2400, // TODO: 从响应头获取
    }
  }
}
```

---

#### 3. 统一数据获取服务

```typescript
// lib/services/data-fetcher.ts
import { BinanceAdapter } from '@/lib/adapters/binance-adapter'
import { BybitAdapter } from '@/lib/adapters/bybit-adapter'
import { OKXAdapter } from '@/lib/adapters/okx-adapter'
import { HyperliquidAdapter } from '@/lib/adapters/hyperliquid-adapter'

export class DataFetcherService {
  private adapters = {
    binance: new BinanceAdapter(),
    bybit: new BybitAdapter(),
    okx: new OKXAdapter(),
    hyperliquid: new HyperliquidAdapter(),
  }

  async fetchTraders(
    exchange: string,
    period: '7D' | '30D' | '90D'
  ) {
    const adapter = this.adapters[exchange]

    if (!adapter) {
      throw new Error(`No adapter for exchange: ${exchange}`)
    }

    // 健康检查
    const isHealthy = await adapter.healthCheck()
    if (!isHealthy) {
      console.error(`${exchange} API is down`)
      // 降级到爬虫备份
      return this.fallbackToScraper(exchange, period)
    }

    // 获取数据
    try {
      const traders = await adapter.getLeaderboard({
        period,
        sortBy: 'roi',
        limit: 100,
      })

      // 存储到数据库
      await this.saveToDatabase(exchange, traders)

      return traders
    } catch (error) {
      console.error(`${exchange} API error:`, error)
      // 降级到爬虫备份
      return this.fallbackToScraper(exchange, period)
    }
  }

  private async fallbackToScraper(exchange: string, period: string) {
    // 保留现有爬虫作为备份
    console.log(`Falling back to scraper for ${exchange}`)
    // ... 调用现有爬虫逻辑
  }
}
```

---

## 📅 分阶段迁移计划

### Phase 1: 顶级CEX API迁移 (Week 1-4)

**目标**: 迁移 Binance, Bybit, OKX (占总交易量 70%)

#### Week 1: 基础设施搭建
- [ ] **Day 1-2**: 创建 Adapter 接口和基类
  - 文件: `lib/adapters/base-adapter.ts`
  - 文件: `lib/adapters/types.ts`

- [ ] **Day 3-4**: 实现 Binance Adapter
  - 文件: `lib/adapters/binance-adapter.ts`
  - 测试: `lib/adapters/__tests__/binance-adapter.test.ts`
  - 申请 Binance API Key (需要KYC)

- [ ] **Day 5**: 限流器集成
  - 文件: `lib/ratelimit/exchange-limiter.ts`
  - 使用 Upstash Redis Sliding Window
  - 配置: Binance 2400req/min

#### Week 2: Bybit + OKX 实现
- [ ] **Day 1-2**: Bybit Adapter
  - 文件: `lib/adapters/bybit-adapter.ts`
  - 限流: 120req/s

- [ ] **Day 3-4**: OKX Adapter
  - 文件: `lib/adapters/okx-adapter.ts`
  - 限流: 20req/2s
  - RSA签名实现

- [ ] **Day 5**: 数据标准化层
  - 文件: `lib/services/data-normalizer.ts`
  - 统一字段映射

#### Week 3: 灰度发布
- [ ] **Day 1-2**: 双写模式
  - 爬虫继续运行
  - API数据并行获取
  - 数据对比验证

- [ ] **Day 3-4**: A/B测试
  - 10%流量使用API数据
  - 监控准确性、延迟

- [ ] **Day 5**: 问题修复

#### Week 4: 切换完成
- [ ] **Day 1-2**: 提升到50%流量
- [ ] **Day 3-4**: 提升到100%流量
- [ ] **Day 5**: 停用Binance/Bybit/OKX爬虫

**成功标准**:
- ✅ API数据准确性 >= 99.9%
- ✅ API响应时间 < 200ms (P95)
- ✅ 每日成功率 > 99.5%
- ✅ 无用户投诉

---

### Phase 2: 中型CEX迁移 (Week 5-8)

**目标**: Bitget, Gate.io, MEXC, KuCoin

#### Week 5-6: Bitget + Gate.io
- [ ] Bitget Adapter (有官方API)
- [ ] Gate.io Adapter (有官方API)
- [ ] 限流配置

#### Week 7-8: MEXC + KuCoin
- [ ] MEXC Adapter (需验证跟单API)
- [ ] KuCoin Adapter (需验证跟单API)
- [ ] 灰度发布

**备注**: 如果某些交易所没有跟单API，保留爬虫方式

---

### Phase 3: 链上DEX迁移 (Week 9-12)

**目标**: GMX, Hyperliquid, dYdX, Jupiter, Drift

#### Week 9-10: The Graph Subgraphs
- [ ] **GMX Subgraph** 集成
  - GraphQL客户端配置
  - 查询优化
  - 付费计划选择 ($100/月 Subgraph Studio)

- [ ] **Synthetix/Kwenta** Subgraph
  - Optimism链数据

#### Week 11: L1/L2 直接API
- [ ] **Hyperliquid** API
  - 无需认证，直接调用

- [ ] **dYdX v4** API
  - Cosmos链查询

#### Week 12: Solana DEX
- [ ] **Jupiter Perps** API
- [ ] **Drift Protocol** API
- [ ] RPC节点配置 (Helius/QuickNode)

---

### Phase 4: 优化与完善 (Week 13-16)

#### Week 13: 性能优化
- [ ] 缓存层优化 (Redis)
- [ ] 批量请求优化
- [ ] 并发控制调优

#### Week 14: 监控告警
- [ ] Datadog APM 集成
- [ ] API健康检查dashboard
- [ ] 异常告警 (PagerDuty)

#### Week 15: 文档与培训
- [ ] API集成文档
- [ ] 故障排查手册
- [ ] 团队培训

#### Week 16: 最终清理
- [ ] 删除废弃的Playwright爬虫代码
- [ ] 代码审查
- [ ] 性能基准测试

---

## ⚠️ 风险管理

### 风险矩阵

| 风险 | 概率 | 影响 | 应对策略 |
|------|------|------|----------|
| **API密钥泄露** | 低 | 高 | 使用 Vercel Secrets，定期轮换 |
| **API突然下线** | 中 | 高 | 保留爬虫备份，自动降级 |
| **限流超标** | 中 | 中 | Redis限流器，优雅降级 |
| **数据格式变更** | 低 | 中 | 版本化Adapter，自动化测试 |
| **成本超预算** | 低 | 低 | 监控API调用量，设置阈值告警 |

### 降级策略

```typescript
// 多层降级机制
async function fetchTraderData(exchange: string) {
  try {
    // 1. 优先使用官方API
    return await apiAdapter.fetch(exchange)
  } catch (apiError) {
    logger.warn('API failed, trying cache', { exchange, error: apiError })

    try {
      // 2. 降级到Redis缓存 (最近1小时数据)
      const cached = await redis.get(`traders:${exchange}`)
      if (cached) return JSON.parse(cached)
    } catch (cacheError) {
      logger.error('Cache failed', { exchange, error: cacheError })
    }

    try {
      // 3. 降级到爬虫备份
      logger.warn('Using scraper fallback', { exchange })
      return await scraperBackup.fetch(exchange)
    } catch (scraperError) {
      logger.error('All methods failed', { exchange, error: scraperError })

      // 4. 最后降级: 返回数据库中最近数据
      return await db.getLatestSnapshot(exchange)
    }
  }
}
```

---

## 💰 成本分析

### API费用估算

| 服务 | 免费额度 | 付费计划 | 预估月成本 |
|------|----------|----------|-----------|
| **Binance API** | 无限制 (有限流) | N/A | $0 |
| **Bybit API** | 无限制 (有限流) | N/A | $0 |
| **OKX API** | 无限制 (有限流) | N/A | $0 |
| **The Graph** | 1000 req/day | $100-500/月 | $200 |
| **Helius RPC** (Solana) | 25M credits | $99-499/月 | $99 |
| **QuickNode** (ETH/Arb) | 3M credits | $49-299/月 | $49 |
| **Upstash Redis** | 10K req/day | $20-100/月 | $20 |
| **Datadog APM** | 免费试用 | $15/host/月 | $45 |

**总计**: ~$413/月

### 节省成本

| 项目 | 当前月成本 | 节省 |
|------|-----------|------|
| 代理IP服务 (Bright Data) | $500 | -$500 |
| Playwright实例 (AWS EC2) | $200 | -$200 |
| 人工维护成本 (20小时/月) | $1000 | -$800 |

**净节省**: $413 - $1700 = **-$1287/月** (节省约75%成本)

---

## 📈 成功指标

### 技术指标

| 指标 | 当前值 | 目标值 | 测量方式 |
|------|--------|--------|----------|
| **数据准确性** | 95% | 99.9% | 与官网对比 |
| **API响应时间 (P95)** | 2-5秒 | <200ms | Datadog APM |
| **每日成功率** | 90% | >99.5% | Sentry错误率 |
| **数据新鲜度** | 4小时 | 15分钟 | 时间戳对比 |
| **系统可用性** | 95% | 99.9% | Uptime监控 |

### 业务指标

| 指标 | 目标 | 测量方式 |
|------|------|----------|
| **用户投诉下降** | -80% | Support tickets |
| **SEO排名提升** | Top 5 | Google Analytics |
| **API调用成本** | <$500/月 | Billing dashboard |
| **开发时间节省** | 20小时/月 | Sprint velocity |

---

## 📝 实施检查清单

### Phase 1 准备 (本周完成)

- [ ] 申请 Binance API Key (需要KYC，3-5天)
- [ ] 申请 Bybit API Key
- [ ] 申请 OKX API Key
- [ ] 设置 Upstash Redis 账户
- [ ] 创建 GitHub Project 看板
- [ ] 编写 RFC 文档提交审批

### 第一周任务 (详细)

**Day 1**:
- [ ] 创建 `lib/adapters/` 目录
- [ ] 实现 `base-adapter.ts` 接口
- [ ] 编写适配器单元测试框架

**Day 2**:
- [ ] 实现 `binance-adapter.ts`
- [ ] 配置环境变量 (`BINANCE_API_KEY`, `BINANCE_API_SECRET`)
- [ ] 本地测试 Binance API 连接

**Day 3**:
- [ ] 实现签名认证逻辑
- [ ] 实现数据解析和标准化
- [ ] 编写集成测试

**Day 4**:
- [ ] 实现限流器 (`lib/ratelimit/exchange-limiter.ts`)
- [ ] Redis配置和测试
- [ ] 错误处理和重试逻辑

**Day 5**:
- [ ] 创建 cron job: `/api/cron/fetch-traders-api/binance`
- [ ] 双写模式: API + 爬虫并行
- [ ] 数据对比验证脚本

---

## 🔗 参考资源

### 官方API文档
- [Binance Copy Trading API](https://binance-docs.github.io/apidocs/futures/en/#copy-trading-endpoints)
- [Bybit Copy Trading API](https://bybit-exchange.github.io/docs/v5/copy-trading/trader-list)
- [OKX Copy Trading API](https://www.okx.com/docs-v5/en/#copy-trading)
- [Hyperliquid API](https://hyperliquid.gitbook.io/hyperliquid-docs/)
- [The Graph Subgraphs](https://thegraph.com/docs/en/)

### 技术栈
- [Upstash Redis](https://upstash.com/) - 限流器
- [Helius RPC](https://helius.dev/) - Solana节点
- [QuickNode](https://www.quicknode.com/) - EVM节点
- [Datadog APM](https://www.datadoghq.com/) - 监控告警

---

## 📞 联系方式

**项目负责人**: Tech Lead
**Slack频道**: #api-migration
**每周进度会**: 周五 10:00 AM
**紧急联系**: PagerDuty Escalation

---

**版本历史**:
- v1.0 (2026-02-06): 初始版本，完整迁移计划

**下次更新**: 2026-02-13 (Phase 1 Week 1 进度报告)
