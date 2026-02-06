# API 迁移快速入门指南

## 🚀 第一周行动计划

### 准备工作（本周内完成）

#### 1. 申请API密钥

**Binance API Key** (最优先，3-5天审批)
```bash
# 访问
https://www.binance.com/zh-CN/my/settings/api-management

# 步骤:
1. 完成KYC验证
2. 启用2FA
3. 创建API Key
4. 权限: 仅勾选"读取" (Read)
5. IP白名单: 添加Vercel出口IP
6. 保存 API Key 和 Secret
```

**Bybit API Key**
```bash
https://www.bybit.com/app/user/api-management

# 权限: Read Only
# 无需IP白名单 (推荐添加)
```

**OKX API Key**
```bash
https://www.okx.com/account/my-api

# 权限: 读取
# 需要2FA + 手机验证
```

#### 2. 配置环境变量

在 Vercel Dashboard 添加:
```bash
# Binance
BINANCE_API_KEY=your_api_key
BINANCE_API_SECRET=your_api_secret

# Bybit
BYBIT_API_KEY=your_api_key
BYBIT_API_SECRET=your_api_secret

# OKX
OKX_API_KEY=your_api_key
OKX_API_SECRET=your_api_secret
OKX_API_PASSPHRASE=your_passphrase

# Upstash Redis (限流器)
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_token
```

#### 3. 创建项目看板

在 GitHub Projects 创建看板:
- **列**: To Do, In Progress, Review, Done
- **里程碑**: Phase 1 (Week 1-4)
- **Issue模板**: 使用 `docs/API_MIGRATION_PLAN.md` 中的任务

---

## 💻 第一周实施代码

### Day 1-2: 基础 Adapter 接口

**创建文件**: `lib/adapters/types.ts`

```typescript
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
  capturedAt: Date
}

export interface LeaderboardParams {
  period: '7D' | '30D' | '90D'
  sortBy: 'roi' | 'pnl' | 'followers'
  limit: number
}

export interface RateLimitInfo {
  limit: number
  window: string
  remaining: number
  resetAt?: Date
}

export interface ExchangeAdapter {
  name: string
  type: 'cex' | 'dex'

  getLeaderboard(params: LeaderboardParams): Promise<TraderData[]>
  getTraderDetails(traderId: string): Promise<TraderData | null>
  healthCheck(): Promise<boolean>
  getRateLimitInfo(): RateLimitInfo
}
```

**创建文件**: `lib/adapters/base-adapter.ts`

```typescript
import { ExchangeAdapter, TraderData, LeaderboardParams, RateLimitInfo } from './types'
import { logger } from '@/lib/logger'

export abstract class BaseAdapter implements ExchangeAdapter {
  abstract name: string
  abstract type: 'cex' | 'dex'

  protected abstract apiKey?: string
  protected abstract apiSecret?: string
  protected abstract baseUrl: string

  async getLeaderboard(params: LeaderboardParams): Promise<TraderData[]> {
    throw new Error('getLeaderboard must be implemented')
  }

  async getTraderDetails(traderId: string): Promise<TraderData | null> {
    throw new Error('getTraderDetails must be implemented')
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v3/ping`, {
        signal: AbortSignal.timeout(5000)
      })
      return response.ok
    } catch (error) {
      logger.error(`${this.name} health check failed`, { error })
      return false
    }
  }

  getRateLimitInfo(): RateLimitInfo {
    return {
      limit: 0,
      window: '1m',
      remaining: 0
    }
  }

  protected async fetchWithRetry(
    url: string,
    options: RequestInit,
    retries = 3
  ): Promise<Response> {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, {
          ...options,
          signal: AbortSignal.timeout(10000)
        })

        if (response.ok) return response

        if (response.status === 429) {
          // 限流，等待后重试
          const retryAfter = parseInt(response.headers.get('Retry-After') || '5')
          await this.sleep(retryAfter * 1000)
          continue
        }

        if (response.status >= 500 && i < retries - 1) {
          // 服务器错误，重试
          await this.sleep(Math.pow(2, i) * 1000)
          continue
        }

        throw new Error(`HTTP ${response.status}: ${await response.text()}`)
      } catch (error) {
        if (i === retries - 1) throw error
        await this.sleep(Math.pow(2, i) * 1000)
      }
    }

    throw new Error('Max retries reached')
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
```

### Day 3-4: Binance Adapter 实现

**创建文件**: `lib/adapters/binance-adapter.ts`

```typescript
import { createHmac } from 'crypto'
import { BaseAdapter } from './base-adapter'
import { TraderData, LeaderboardParams } from './types'
import { rateLimit } from '@/lib/ratelimit'

export class BinanceAdapter extends BaseAdapter {
  name = 'binance'
  type = 'cex' as const

  protected apiKey = process.env.BINANCE_API_KEY!
  protected apiSecret = process.env.BINANCE_API_SECRET!
  protected baseUrl = 'https://api.binance.com'

  private generateSignature(queryString: string): string {
    return createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex')
  }

  async getLeaderboard(params: LeaderboardParams): Promise<TraderData[]> {
    // 限流检查 (2400/min = 40/sec)
    await rateLimit.check('binance', 40)

    const timestamp = Date.now()
    const queryString = new URLSearchParams({
      period: params.period,
      sortBy: params.sortBy,
      limit: params.limit.toString(),
      timestamp: timestamp.toString()
    }).toString()

    const signature = this.generateSignature(queryString)
    const url = `${this.baseUrl}/sapi/v1/copyTrading/futures/leadUserPerformance?${queryString}&signature=${signature}`

    const response = await this.fetchWithRetry(url, {
      method: 'GET',
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/json'
      }
    })

    const data = await response.json()

    // 数据标准化
    return data.data.map((trader: any, index: number) => ({
      traderId: trader.encryptedUid,
      nickname: trader.nickName || null,
      roi: parseFloat(trader.roi) || 0,
      pnl: parseFloat(trader.pnl) || 0,
      maxDrawdown: parseFloat(trader.maxDrawDown) || 0,
      winRate: parseFloat(trader.winRate) || 0,
      followers: trader.followers || 0,
      aum: parseFloat(trader.aum) || 0,
      tradeCount: trader.tradeCount || 0,
      period: params.period,
      capturedAt: new Date()
    }))
  }

  async getTraderDetails(traderId: string): Promise<TraderData | null> {
    // TODO: 实现获取单个交易员详情
    // Binance API: /sapi/v1/copyTrading/futures/userPerformance?encryptedUid={traderId}
    return null
  }

  getRateLimitInfo() {
    return {
      limit: 2400,
      window: '1m',
      remaining: 2400 // TODO: 从响应头解析
    }
  }
}
```

### Day 5: Cron Job 集成

**创建文件**: `app/api/cron/fetch-traders-api/binance/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { BinanceAdapter } from '@/lib/adapters/binance-adapter'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request: NextRequest) {
  // 验证 cron secret
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const adapter = new BinanceAdapter()
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const startTime = Date.now()
  let processed = 0
  let inserted = 0
  let errors = 0

  try {
    // 获取3个时间周期的数据
    for (const period of ['7D', '30D', '90D'] as const) {
      logger.info(`Fetching Binance ${period} leaderboard`)

      try {
        const traders = await adapter.getLeaderboard({
          period,
          sortBy: 'roi',
          limit: 100
        })

        // 存储到数据库
        for (const trader of traders) {
          const { error } = await supabase
            .from('trader_snapshots')
            .upsert({
              source: 'binance_futures',
              source_trader_id: trader.traderId,
              window: period,
              nickname: trader.nickname,
              roi: trader.roi,
              pnl: trader.pnl,
              max_drawdown: trader.maxDrawdown,
              win_rate: trader.winRate,
              followers: trader.followers,
              trades_count: trader.tradeCount,
              aum: trader.aum,
              captured_at: new Date().toISOString(),
              data_source: 'api' // 标记数据来源
            }, {
              onConflict: 'source,source_trader_id,window'
            })

          if (error) {
            logger.error('DB insert error', { trader: trader.traderId, error })
            errors++
          } else {
            inserted++
          }

          processed++
        }

        logger.info(`Binance ${period} complete`, {
          traders: traders.length,
          inserted
        })

        // 避免限流，等待1秒
        await new Promise(resolve => setTimeout(resolve, 1000))

      } catch (error) {
        logger.error(`Binance ${period} failed`, { error })
        errors++
      }
    }

    const duration = Date.now() - startTime

    return NextResponse.json({
      success: true,
      source: 'binance_futures',
      processed,
      inserted,
      errors,
      duration: `${duration}ms`
    })

  } catch (error) {
    logger.error('Binance fetch fatal error', { error })
    return NextResponse.json({
      error: 'Fatal error',
      details: error instanceof Error ? error.message : 'Unknown error',
      processed,
      inserted,
      errors
    }, { status: 500 })
  }
}
```

**更新**: `vercel.json`

```json
{
  "crons": [
    {
      "path": "/api/cron/fetch-traders-api/binance",
      "schedule": "0 */4 * * *"
    }
  ]
}
```

---

## 🧪 测试步骤

### 1. 本地测试 Adapter

**创建文件**: `scripts/test-binance-adapter.ts`

```typescript
import { BinanceAdapter } from '../lib/adapters/binance-adapter'

async function test() {
  const adapter = new BinanceAdapter()

  console.log('Testing Binance API connection...')

  // 健康检查
  const isHealthy = await adapter.healthCheck()
  console.log('Health check:', isHealthy ? '✅' : '❌')

  if (!isHealthy) {
    console.error('API is down, aborting')
    return
  }

  // 获取7D排行榜
  console.log('\nFetching 7D leaderboard...')
  const traders = await adapter.getLeaderboard({
    period: '7D',
    sortBy: 'roi',
    limit: 10
  })

  console.log(`\nFetched ${traders.length} traders:`)
  traders.slice(0, 5).forEach((trader, i) => {
    console.log(`${i + 1}. ${trader.nickname || trader.traderId}`)
    console.log(`   ROI: ${trader.roi}%`)
    console.log(`   PNL: $${trader.pnl.toLocaleString()}`)
    console.log(`   Followers: ${trader.followers}`)
    console.log('')
  })

  // 限流信息
  const rateLimit = adapter.getRateLimitInfo()
  console.log('Rate limit:', rateLimit)
}

test().catch(console.error)
```

运行:
```bash
npx tsx scripts/test-binance-adapter.ts
```

### 2. Cron Job 本地测试

```bash
# 启动开发服务器
npm run dev

# 在另一个终端，手动触发cron
curl -X POST http://localhost:3000/api/cron/fetch-traders-api/binance \
  -H "Authorization: Bearer ${CRON_SECRET}"

# 查看日志输出
```

### 3. 数据验证

```sql
-- 检查新数据
SELECT
  source,
  window,
  data_source,
  COUNT(*) as count,
  MAX(captured_at) as latest
FROM trader_snapshots
WHERE source = 'binance_futures'
  AND data_source = 'api'
GROUP BY source, window, data_source
ORDER BY latest DESC;

-- 对比API vs 爬虫数据
SELECT
  ts1.source_trader_id,
  ts1.nickname,
  ts1.roi as api_roi,
  ts2.roi as scraper_roi,
  ABS(ts1.roi - ts2.roi) as diff
FROM trader_snapshots ts1
JOIN trader_snapshots ts2
  ON ts1.source_trader_id = ts2.source_trader_id
  AND ts1.window = ts2.window
WHERE ts1.source = 'binance_futures'
  AND ts1.data_source = 'api'
  AND ts2.data_source = 'scraper'
  AND ts1.window = '7D'
ORDER BY diff DESC
LIMIT 20;
```

---

## 📊 监控仪表板设置

### Vercel Analytics

在 Vercel Dashboard 添加自定义事件:

```typescript
// lib/analytics/track.ts
export function trackApiCall(
  exchange: string,
  success: boolean,
  duration: number
) {
  if (typeof window !== 'undefined') {
    window.va?.track('api_call', {
      exchange,
      success,
      duration
    })
  }
}

// 在 adapter 中使用
const start = Date.now()
try {
  const result = await adapter.getLeaderboard(params)
  trackApiCall('binance', true, Date.now() - start)
  return result
} catch (error) {
  trackApiCall('binance', false, Date.now() - start)
  throw error
}
```

### Upstash Redis 限流器

**创建文件**: `lib/ratelimit/exchange-limiter.ts`

```typescript
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!
})

export const rateLimiters = {
  binance: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(40, '1 s'), // 40 req/sec
    analytics: true,
    prefix: 'ratelimit:binance'
  }),

  bybit: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(120, '1 s'),
    analytics: true,
    prefix: 'ratelimit:bybit'
  }),

  okx: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, '1 s'), // 20req/2s = 10/s
    analytics: true,
    prefix: 'ratelimit:okx'
  })
}

export const rateLimit = {
  async check(exchange: string, limit: number) {
    const limiter = rateLimiters[exchange]
    if (!limiter) return { success: true }

    const result = await limiter.limit(exchange)

    if (!result.success) {
      const resetInMs = result.reset - Date.now()
      throw new Error(`Rate limit exceeded, retry in ${resetInMs}ms`)
    }

    return result
  }
}
```

---

## 🎯 第一周成功标准

### 必须完成 ✅
- [ ] Binance API Key 获取并配置
- [ ] `BinanceAdapter` 实现并通过测试
- [ ] Cron job 成功运行至少1次
- [ ] 数据库中有 >50 条 Binance API 数据
- [ ] API响应时间 < 500ms

### 可选目标 🎁
- [ ] Bybit Adapter 开始实现
- [ ] 限流器集成测试
- [ ] 监控仪表板原型

---

## 🆘 故障排查

### 问题: API Key 无效
```bash
Error: HTTP 401: {"code":-2015,"msg":"Invalid API-key, IP, or permissions"}
```

**解决**:
1. 检查 API Key 是否正确复制 (无空格)
2. 确认 IP 白名单包含 Vercel 出口 IP
3. 确认权限包含 "读取" (Read)
4. 重新生成 API Key

### 问题: 限流错误
```bash
Error: HTTP 429: Rate limit exceeded
```

**解决**:
1. 检查 `lib/ratelimit/exchange-limiter.ts` 配置
2. 降低请求频率
3. 添加重试逻辑

### 问题: 数据格式不匹配
```bash
Error: Cannot read property 'roi' of undefined
```

**解决**:
1. 打印原始API响应: `console.log(JSON.stringify(data, null, 2))`
2. 检查Binance API文档是否有变更
3. 更新数据映射逻辑

---

## 📚 下一步

完成第一周任务后:
1. 提交 PR 并进行 Code Review
2. 部署到 Staging 环境测试
3. 灰度发布: 10% 流量使用API数据
4. 监控7天，收集反馈
5. 开始 Week 2: Bybit + OKX 实现

**祝你迁移顺利！** 🚀

有问题随时在 Slack #api-migration 频道提问。
