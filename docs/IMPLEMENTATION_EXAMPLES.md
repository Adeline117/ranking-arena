# Arena Pipeline 新架构实现示例

## 1. BullMQ队列搭建

### 1.1 安装依赖

```bash
npm install bullmq ioredis
npm install --save-dev @types/bullmq
```

### 1.2 Redis连接配置

```typescript
// lib/queue/redis-connection.ts
import { Redis } from 'ioredis'

// Upstash Redis连接（serverless-friendly）
export const REDIS_CONNECTION = new Redis(process.env.UPSTASH_REDIS_URL!, {
  maxRetriesPerRequest: null, // BullMQ要求
  enableReadyCheck: false,
})

// 健康检查
export async function checkRedisHealth(): Promise<boolean> {
  try {
    await REDIS_CONNECTION.ping()
    return true
  } catch (error) {
    console.error('Redis health check failed:', error)
    return false
  }
}
```

### 1.3 队列定义

```typescript
// lib/queue/enrichment-queue.ts
import { Queue, QueueOptions } from 'bullmq'
import { REDIS_CONNECTION } from './redis-connection'

const queueOptions: QueueOptions = {
  connection: REDIS_CONNECTION,
  defaultJobOptions: {
    attempts: 3, // 失败后重试3次
    backoff: {
      type: 'exponential',
      delay: 5000, // 5s, 10s, 20s
    },
    removeOnComplete: {
      age: 86400, // 24小时后删除已完成job
      count: 1000, // 最多保留1000个
    },
    removeOnFail: {
      age: 604800, // 7天后删除失败job
      count: 5000,
    },
  },
}

// 3个优先级队列
export const HIGH_PRIORITY_QUEUE = new Queue('enrich-high', {
  ...queueOptions,
  defaultJobOptions: {
    ...queueOptions.defaultJobOptions,
    priority: 1,
  },
})

export const MEDIUM_PRIORITY_QUEUE = new Queue('enrich-medium', {
  ...queueOptions,
  defaultJobOptions: {
    ...queueOptions.defaultJobOptions,
    priority: 5,
  },
})

export const LOW_PRIORITY_QUEUE = new Queue('enrich-low', {
  ...queueOptions,
  defaultJobOptions: {
    ...queueOptions.defaultJobOptions,
    priority: 10,
  },
})

// Job数据类型
export interface EnrichmentJobData {
  platform: string
  period: '7D' | '30D' | '90D'
  traders: Array<{
    trader_id: string
    trader_key: string
  }>
  priority: 'high' | 'medium' | 'low'
  triggeredBy: 'cron' | 'on-demand' // 触发来源
  timestamp: number
}

// 添加job到队列
export async function enqueueEnrichmentJob(data: EnrichmentJobData) {
  const queue = 
    data.priority === 'high' ? HIGH_PRIORITY_QUEUE :
    data.priority === 'medium' ? MEDIUM_PRIORITY_QUEUE :
    LOW_PRIORITY_QUEUE

  const jobId = `${data.platform}-${data.period}-${Date.now()}`

  const job = await queue.add(
    `enrich-${data.platform}`,
    data,
    {
      jobId, // 幂等性：相同jobId不会重复添加
      priority: data.priority === 'high' ? 1 : data.priority === 'medium' ? 5 : 10,
    }
  )

  console.log(`✅ Enqueued job ${job.id} for ${data.platform}/${data.period} (${data.traders.length} traders)`)
  
  return job
}

// 批量添加jobs（用于cron触发）
export async function enqueueBatchEnrichmentJobs(
  platforms: string[],
  period: '7D' | '30D' | '90D',
  priority: 'high' | 'medium' | 'low' = 'medium'
) {
  // TODO: 从DB查询每个platform的traders
  const jobsData: EnrichmentJobData[] = platforms.map(platform => ({
    platform,
    period,
    traders: [], // 从DB查询
    priority,
    triggeredBy: 'cron',
    timestamp: Date.now(),
  }))

  const jobs = await Promise.all(jobsData.map(enqueueEnrichmentJob))
  
  console.log(`✅ Enqueued ${jobs.length} enrichment jobs for ${period}`)
  
  return jobs
}
```

### 1.4 队列监控工具

```typescript
// lib/queue/queue-monitor.ts
import { Queue, QueueEvents } from 'bullmq'
import { REDIS_CONNECTION } from './redis-connection'

export class QueueMonitor {
  private queueEvents: QueueEvents

  constructor(queueName: string) {
    this.queueEvents = new QueueEvents(queueName, {
      connection: REDIS_CONNECTION,
    })

    this.setupListeners()
  }

  private setupListeners() {
    this.queueEvents.on('completed', ({ jobId }) => {
      console.log(`✅ Job ${jobId} completed`)
    })

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      console.error(`❌ Job ${jobId} failed:`, failedReason)
    })

    this.queueEvents.on('progress', ({ jobId, data }) => {
      console.log(`📊 Job ${jobId} progress:`, data)
    })

    this.queueEvents.on('stalled', ({ jobId }) => {
      console.warn(`⚠️ Job ${jobId} stalled`)
    })
  }

  async getQueueStats(queue: Queue) {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ])

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: waiting + active + delayed,
    }
  }
}
```

---

## 2. Railway Worker实现

### 2.1 Worker主文件

```typescript
// worker/enrichment-worker.ts
import { Worker, Job } from 'bullmq'
import { REDIS_CONNECTION } from '../lib/queue/redis-connection'
import { EnrichmentJobData } from '../lib/queue/enrichment-queue'
import { runEnrichment } from '../lib/cron/enrichment-runner'
import { createClient } from '@supabase/supabase-js'
import express from 'express'

// 创建Supabase client（使用service_role key）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Worker配置
const WORKER_CONFIG = {
  high: { concurrency: 5, queueName: 'enrich-high' },
  medium: { concurrency: 3, queueName: 'enrich-medium' },
  low: { concurrency: 2, queueName: 'enrich-low' },
}

// 处理单个job的逻辑
async function processEnrichmentJob(job: Job<EnrichmentJobData>) {
  const { platform, period, traders, triggeredBy } = job.data
  
  console.log(`[Worker] Processing ${job.id}: ${platform}/${period} (${traders.length} traders, triggered by ${triggeredBy})`)

  const startTime = Date.now()

  try {
    // 报告进度：0%
    await job.updateProgress(0)

    // 运行enrichment（复用现有逻辑）
    const result = await runEnrichment({
      platform,
      period,
      limit: traders.length,
      supabase, // 传入supabase client
    })

    // 报告进度：100%
    await job.updateProgress(100)

    const durationMs = Date.now() - startTime
    const durationMin = Math.round(durationMs / 60000)

    console.log(`[Worker] ✅ Completed ${job.id}: ${result.summary.enriched}/${result.summary.total} enriched in ${durationMin}min`)

    // 返回结果（BullMQ会自动保存）
    return {
      ok: result.ok,
      summary: result.summary,
      durationMs,
      platform,
      period,
    }
  } catch (error) {
    const durationMs = Date.now() - startTime
    console.error(`[Worker] ❌ Failed ${job.id} after ${Math.round(durationMs / 1000)}s:`, error)
    
    throw error // BullMQ会自动处理重试
  }
}

// 创建3个worker（每个处理一个优先级队列）
function createWorkers() {
  const workers = Object.entries(WORKER_CONFIG).map(([priority, config]) => {
    const worker = new Worker(
      config.queueName,
      processEnrichmentJob,
      {
        connection: REDIS_CONNECTION,
        concurrency: config.concurrency,
        limiter: {
          max: 10, // 每秒最多处理10个job（防止API rate limit）
          duration: 1000,
        },
        // 失败后不自动重试（由BullMQ的attempts配置控制）
        autorun: true,
      }
    )

    // Worker事件监听
    worker.on('completed', (job) => {
      console.log(`[${priority}] ✅ Job ${job.id} completed`)
    })

    worker.on('failed', (job, err) => {
      console.error(`[${priority}] ❌ Job ${job?.id} failed:`, err.message)
    })

    worker.on('error', (err) => {
      console.error(`[${priority}] Worker error:`, err)
    })

    worker.on('stalled', (jobId) => {
      console.warn(`[${priority}] ⚠️ Job ${jobId} stalled (worker crashed?)`)
    })

    return worker
  })

  console.log(`🚀 Started ${workers.length} workers (high: ${WORKER_CONFIG.high.concurrency}, medium: ${WORKER_CONFIG.medium.concurrency}, low: ${WORKER_CONFIG.low.concurrency})`)

  return workers
}

// 健康检查HTTP服务（Railway需要）
function startHealthCheckServer() {
  const app = express()
  const PORT = process.env.PORT || 3001

  app.get('/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    })
  })

  app.get('/stats', async (req, res) => {
    try {
      const stats = await Promise.all(
        Object.values(WORKER_CONFIG).map(async config => {
          const queue = new Queue(config.queueName, { connection: REDIS_CONNECTION })
          const [waiting, active, completed, failed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount(),
          ])
          return {
            queue: config.queueName,
            waiting,
            active,
            completed,
            failed,
          }
        })
      )
      res.json({ stats })
    } catch (error) {
      res.status(500).json({ error: 'Failed to get stats' })
    }
  })

  app.listen(PORT, () => {
    console.log(`🏥 Health check server running on port ${PORT}`)
  })
}

// 优雅退出
function setupGracefulShutdown(workers: Worker[]) {
  const shutdown = async () => {
    console.log('🛑 Shutting down workers...')
    
    await Promise.all(workers.map(w => w.close()))
    
    await REDIS_CONNECTION.quit()
    
    console.log('✅ Graceful shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

// 启动worker
async function main() {
  console.log('🚀 Starting Arena Enrichment Worker...')

  const workers = createWorkers()
  startHealthCheckServer()
  setupGracefulShutdown(workers)

  console.log('✅ Worker ready')
}

main().catch(err => {
  console.error('❌ Worker startup failed:', err)
  process.exit(1)
})
```

### 2.2 Worker package.json

```json
{
  "name": "arena-enrichment-worker",
  "version": "1.0.0",
  "scripts": {
    "start": "node -r dotenv/config dist/worker/enrichment-worker.js",
    "build": "tsc",
    "dev": "tsx watch worker/enrichment-worker.ts"
  },
  "dependencies": {
    "bullmq": "^5.0.0",
    "ioredis": "^5.3.0",
    "express": "^4.18.0",
    "@supabase/supabase-js": "^2.39.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/express": "^4.17.0",
    "tsx": "^4.0.0",
    "typescript": "^5.3.0",
    "dotenv": "^16.0.0"
  }
}
```

### 2.3 Railway配置

```toml
# railway.toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "npm run start"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
healthcheckPath = "/health"
healthcheckTimeout = 30

[env]
NODE_ENV = "production"
```

---

## 3. 修改Vercel Cron触发逻辑

### 3.1 修改batch-fetch-traders

```typescript
// app/api/cron/batch-fetch-traders/route.ts
import { enqueueEnrichmentJob } from '@/lib/queue/enrichment-queue'

export async function GET(request: NextRequest) {
  // ... existing fetch logic ...

  const results = await Promise.all(platforms.map(runPlatform))

  // NEW: 每个成功的平台触发enrichment job
  const USE_QUEUE_ENRICHMENT = process.env.USE_QUEUE_ENRICHMENT === 'true'

  if (USE_QUEUE_ENRICHMENT) {
    for (const result of results) {
      if (result.status === 'success' && result.totalSaved && result.totalSaved > 0) {
        try {
          // 从DB查询该平台的traders
          const { data: traders } = await supabase
            .from('trader_snapshots_v2')
            .select('trader_id, trader_key')
            .eq('source', result.platform)
            .order('arena_score', { ascending: false })
            .limit(getPlatformEnrichmentLimit(result.platform))

          if (traders && traders.length > 0) {
            // 添加到队列
            await enqueueEnrichmentJob({
              platform: result.platform,
              period: '90D', // 先enrichment 90D，其他period后续触发
              traders,
              priority: getPlatformPriority(result.platform),
              triggeredBy: 'cron',
              timestamp: Date.now(),
            })

            console.log(`✅ Enqueued enrichment job for ${result.platform}: ${traders.length} traders`)
          }
        } catch (err) {
          console.error(`❌ Failed to enqueue enrichment for ${result.platform}:`, err)
        }
      }
    }
  }

  return NextResponse.json({
    ok: succeeded === results.length,
    group,
    platforms: platforms.length,
    succeeded,
    failed,
    totalDurationMs: Date.now() - overallStart,
    results,
    enrichmentJobsEnqueued: USE_QUEUE_ENRICHMENT ? succeeded : 0,
  })
}

// 辅助函数：获取平台优先级
function getPlatformPriority(platform: string): 'high' | 'medium' | 'low' {
  const HIGH_PRIORITY = ['binance_futures', 'okx_futures', 'bitget_futures', 'hyperliquid']
  const MEDIUM_PRIORITY = ['binance_spot', 'htx_futures', 'gateio', 'mexc']
  
  if (HIGH_PRIORITY.includes(platform)) return 'high'
  if (MEDIUM_PRIORITY.includes(platform)) return 'medium'
  return 'low'
}

// 辅助函数：获取平台enrichment限额
function getPlatformEnrichmentLimit(platform: string): number {
  const LIMITS: Record<string, number> = {
    binance_futures: 200,
    okx_futures: 80,
    hyperliquid: 50,
    // ... 其他平台
  }
  return LIMITS[platform] || 50
}
```

---

## 4. 分层缓存实现

### 4.1 L1 Cache（基础leaderboard）

```typescript
// app/api/rankings/route.ts
import { redis } from '@/lib/cache/redis-layer'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const window = searchParams.get('window') as '7d' | '30d' | '90d'
  const category = searchParams.get('category') as string | null
  const platform = searchParams.get('platform') as string | null

  // L1 Cache Key
  const cacheKey = `leaderboard:v1:${window}:${category || 'all'}:${platform || 'all'}`

  // L1: 尝试从Redis读取
  const cached = await redis.get(cacheKey)
  if (cached) {
    console.log(`[L1 Cache Hit] ${cacheKey}`)
    return NextResponse.json(JSON.parse(cached), {
      headers: {
        'X-Cache': 'HIT',
        'X-Cache-Layer': 'L1',
        'Cache-Control': 's-maxage=60, stale-while-revalidate=300',
      },
    })
  }

  console.log(`[L1 Cache Miss] ${cacheKey}`)

  // L1 miss: 从DB读取基础数据（只有fetch阶段的数据）
  const supabase = getSupabaseAdmin()
  
  let query = supabase
    .from('trader_snapshots_v2')
    .select(`
      trader_id,
      trader_key,
      source,
      arena_score,
      roi,
      pnl,
      drawdown,
      total_trades,
      win_rate,
      avg_hold_time,
      last_active_at
    `)
    .eq('period', window === '7d' ? '7D' : window === '30d' ? '30D' : '90D')
    .order('arena_score', { ascending: false })
    .limit(100)

  if (category) {
    const platformsInCategory = getCategoryPlatforms(category)
    query = query.in('source', platformsInCategory)
  }

  if (platform) {
    query = query.eq('source', platform)
  }

  const { data: traders, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const response = {
    data: traders,
    meta: {
      window,
      category,
      platform,
      count: traders?.length || 0,
      enrichmentStatus: 'l1', // 告诉前端这是L1数据（无enrichment）
      cacheLayer: 'DB',
    },
  }

  // 写入L1 cache (60s TTL)
  await redis.setex(cacheKey, 60, JSON.stringify(response))

  return NextResponse.json(response, {
    headers: {
      'X-Cache': 'MISS',
      'X-Cache-Layer': 'L1',
      'Cache-Control': 's-maxage=60, stale-while-revalidate=300',
    },
  })
}
```

### 4.2 L2 Cache（Enrichment数据）

```typescript
// app/api/trader/[id]/equity-curve/route.ts
import { redis } from '@/lib/cache/redis-layer'
import { enqueueEnrichmentJob } from '@/lib/queue/enrichment-queue'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const traderId = params.id
  const period = (request.nextUrl.searchParams.get('period') || '30D') as '7D' | '30D' | '90D'

  // L2 Cache Key
  const cacheKey = `equity_curve:${traderId}:${period}`

  // L2: 尝试从Redis读取
  const cached = await redis.get(cacheKey)
  if (cached) {
    console.log(`[L2 Cache Hit] ${cacheKey}`)
    return NextResponse.json(JSON.parse(cached), {
      headers: {
        'X-Cache': 'HIT',
        'X-Cache-Layer': 'L2',
        'Cache-Control': 's-maxage=300, stale-while-revalidate=600',
      },
    })
  }

  console.log(`[L2 Cache Miss] ${cacheKey}`)

  // L2 miss: 从DB读取
  const supabase = getSupabaseAdmin()
  const { data: curve, error } = await supabase
    .from('equity_curves')
    .select('*')
    .eq('trader_id', traderId)
    .eq('period', period)
    .order('date', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (curve && curve.length > 0) {
    // DB有数据：写入L2 cache (3h TTL)
    await redis.setex(cacheKey, 10800, JSON.stringify(curve))

    return NextResponse.json(curve, {
      headers: {
        'X-Cache': 'MISS',
        'X-Cache-Layer': 'L2',
        'Cache-Control': 's-maxage=300, stale-while-revalidate=600',
      },
    })
  }

  // DB无数据：触发按需enrichment（仅针对top traders）
  const isTop = await isTopTrader(traderId)
  
  if (!isTop) {
    // 非top trader：不触发enrichment
    return NextResponse.json(
      { 
        error: 'Data not available for this trader',
        enrichmentStatus: 'not-eligible',
      },
      { status: 404 }
    )
  }

  // Top trader：触发high priority enrichment
  try {
    const { data: traderSnapshot } = await supabase
      .from('trader_snapshots_v2')
      .select('trader_key, source')
      .eq('trader_id', traderId)
      .single()

    if (traderSnapshot) {
      await enqueueEnrichmentJob({
        platform: traderSnapshot.source,
        period,
        traders: [{ trader_id: traderId, trader_key: traderSnapshot.trader_key }],
        priority: 'high', // 按需enrichment = 高优先级
        triggeredBy: 'on-demand',
        timestamp: Date.now(),
      })

      console.log(`✅ Triggered on-demand enrichment for trader ${traderId}`)
    }
  } catch (err) {
    console.error(`❌ Failed to trigger on-demand enrichment:`, err)
  }

  // 返回pending状态
  return NextResponse.json(
    {
      status: 'pending',
      message: 'Enrichment in progress. Please retry in 30-60 seconds.',
      enrichmentStatus: 'pending',
      retryAfter: 30,
    },
    {
      status: 202, // 202 Accepted
      headers: {
        'Retry-After': '30',
        'X-Cache': 'MISS',
        'X-Cache-Layer': 'L2-PENDING',
      },
    }
  )
}

// 辅助函数：判断是否为top trader
async function isTopTrader(traderId: string): Promise<boolean> {
  const supabase = getSupabaseAdmin()
  const { data } = await supabase
    .from('trader_snapshots_v2')
    .select('arena_score')
    .eq('trader_id', traderId)
    .order('arena_score', { ascending: false })
    .limit(1)
    .single()

  if (!data) return false

  // 检查是否在前100名
  const { count } = await supabase
    .from('trader_snapshots_v2')
    .select('trader_id', { count: 'exact', head: true })
    .gte('arena_score', data.arena_score)

  return (count || 0) <= 100
}
```

### 4.3 L3 Cache（预计算metrics）

```typescript
// app/api/cron/precompute-metrics/route.ts
import { redis } from '@/lib/cache/redis-layer'

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()

  console.log('[L3] Computing market correlation...')
  const marketCorrelation = await calculateMarketCorrelation(supabase)
  await redis.setex('metrics:market_correlation', 86400, JSON.stringify(marketCorrelation))

  console.log('[L3] Computing tier distribution...')
  const tierDistribution = await calculateTierDistribution(supabase)
  await redis.setex('metrics:tier_distribution', 86400, JSON.stringify(tierDistribution))

  console.log('[L3] Computing platform rankings...')
  const platformRankings = await calculatePlatformRankings(supabase)
  await redis.setex('metrics:platform_rankings', 86400, JSON.stringify(platformRankings))

  console.log('✅ L3 metrics precomputed')

  return NextResponse.json({
    ok: true,
    metrics: ['market_correlation', 'tier_distribution', 'platform_rankings'],
    ttl: 86400,
  })
}

async function calculateMarketCorrelation(supabase: any) {
  // 计算traders与BTC价格的相关性
  // ...
}

async function calculateTierDistribution(supabase: any) {
  // 计算各tier的trader分布
  // ...
}

async function calculatePlatformRankings(supabase: any) {
  // 计算平台综合排名
  // ...
}
```

---

## 5. 监控告警

### 5.1 BullMQ监控面板（可选）

```typescript
// app/api/admin/queue-dashboard/route.ts
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { ExpressAdapter } from '@bull-board/express'
import { HIGH_PRIORITY_QUEUE, MEDIUM_PRIORITY_QUEUE, LOW_PRIORITY_QUEUE } from '@/lib/queue/enrichment-queue'

const serverAdapter = new ExpressAdapter()
serverAdapter.setBasePath('/api/admin/queue-dashboard')

createBullBoard({
  queues: [
    new BullMQAdapter(HIGH_PRIORITY_QUEUE),
    new BullMQAdapter(MEDIUM_PRIORITY_QUEUE),
    new BullMQAdapter(LOW_PRIORITY_QUEUE),
  ],
  serverAdapter,
})

export const GET = serverAdapter.getRouter()
```

访问 `https://your-app.vercel.app/api/admin/queue-dashboard` 即可查看队列状态。

### 5.2 Slack告警

```typescript
// lib/alerts/queue-alerts.ts
import { sendSlackAlert } from './slack'
import { HIGH_PRIORITY_QUEUE, MEDIUM_PRIORITY_QUEUE, LOW_PRIORITY_QUEUE } from '../queue/enrichment-queue'

export async function checkQueueHealth() {
  const queues = [
    { name: 'high', queue: HIGH_PRIORITY_QUEUE },
    { name: 'medium', queue: MEDIUM_PRIORITY_QUEUE },
    { name: 'low', queue: LOW_PRIORITY_QUEUE },
  ]

  for (const { name, queue } of queues) {
    const waiting = await queue.getWaitingCount()
    const failed = await queue.getFailedCount()

    // 告警条件1：堆积超过500
    if (waiting > 500) {
      await sendSlackAlert({
        title: `⚠️ Queue Backlog: ${name}`,
        message: `${waiting} jobs waiting in ${name} priority queue`,
        severity: 'warning',
      })
    }

    // 告警条件2：失败率>10%
    const completed = await queue.getCompletedCount()
    const failRate = completed > 0 ? (failed / (completed + failed)) * 100 : 0
    
    if (failRate > 10) {
      await sendSlackAlert({
        title: `❌ High Failure Rate: ${name}`,
        message: `${failRate.toFixed(1)}% jobs failed in ${name} priority queue (${failed}/${completed + failed})`,
        severity: 'critical',
      })
    }
  }
}
```

---

## 6. 环境变量配置

### 6.1 Vercel环境变量

```env
# .env.production (Vercel)
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxx
CRON_SECRET=xxx
UPSTASH_REDIS_URL=redis://xxx@xxx.upstash.io:6379

# Feature Flag
USE_QUEUE_ENRICHMENT=true  # false = 旧架构，true = 新架构
```

### 6.2 Railway环境变量

```env
# Railway环境变量
NODE_ENV=production
REDIS_URL=redis://xxx:6379  # Railway Redis或Upstash Redis
DATABASE_URL=postgresql://xxx  # Supabase connection string
SUPABASE_SERVICE_ROLE_KEY=xxx
PORT=3001
```

---

## 总结

这些示例代码展示了新架构的核心实现：

1. **BullMQ队列**：3个优先级队列 + 可靠的job管理
2. **Railway Worker**：无超时限制 + 自动重试 + 健康检查
3. **Vercel Cron改造**：fetch完成后触发enrichment job
4. **分层缓存**：L1(60s) + L2(3h) + L3(24h)
5. **按需enrichment**：用户查看时实时触发high priority job
6. **监控告警**：BullMQ面板 + Slack通知

**下一步**：开始Phase 1基础设施搭建 🚀
