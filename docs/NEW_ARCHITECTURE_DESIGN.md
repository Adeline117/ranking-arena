# Arena Pipeline 新架构设计

## 当前架构分析

### 现状
```
Vercel Cron (每3-6小时)
  ↓
batch-fetch-traders (600s maxDuration)
  → 26个平台分组 (group a-i)
  → 每个平台并行fetch，单平台timeout 420s
  → 直接写入DB
  ↓
batch-enrich (600s maxDuration)
  → 补充trader详细数据
  → 并发度7，onchain 180s timeout, CEX 120s timeout
  → 经常超时（特别是30D/7D/90D with all=true）
  ↓
compute-leaderboard (每30分钟)
  → 计算排名，写入cache
  ↓
/api/rankings (60s cache)
  → 读取缓存数据返回
```

### 核心痛点
1. **超时频发**：batch-enrich 30D/7D/90D经常触发600s限制
2. **无法扩展**：Cloudflare 120s硬限制无法绕过
3. **串行瓶颈**：enrichment串行处理大量trader，无法并行扩展
4. **资源浪费**：每次都enrichment所有trader，即使只有top 100被查看
5. **数据新鲜度**：3-6小时更新周期 vs 用户期望实时

---

## 方案对比矩阵

| 方案 | 性能 | 复杂度 | 成本 | 风险 | 实施难度 | 推荐度 |
|------|------|--------|------|------|----------|--------|
| **A: 微服务化** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | $$$$ | ⭐⭐⭐⭐ | 9/10 | ⭐⭐⭐ |
| **B: 队列 + Worker** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | $$$ | ⭐⭐⭐ | 7/10 | ⭐⭐⭐⭐⭐ |
| **C: 分层缓存** | ⭐⭐⭐⭐ | ⭐⭐⭐ | $$ | ⭐⭐ | 5/10 | ⭐⭐⭐⭐ |
| **D: 渐进式优化** | ⭐⭐ | ⭐ | $ | ⭐ | 3/10 | ⭐⭐ |

### 详细对比

#### 方案A: 微服务化
**优点**：
- 独立扩展（fetch service vs enrich service）
- 容错性好（单个服务失败不影响全局）
- 清晰的职责分离

**缺点**：
- 架构复杂度高（需要API Gateway、服务注册等）
- 成本高（多个独立服务）
- Vercel生态不友好（Vercel不适合微服务架构）

**技术栈**：
- AWS Lambda / ECS (独立于Vercel)
- API Gateway
- Service Mesh (可选)

**实施难度**：9/10
**推荐度**：⭐⭐⭐ (过度设计，不适合现阶段)

---

#### 方案B: 队列 + Worker
**优点**：
- **绕过Lambda超时限制**（worker可以跑任意长时间）
- 可靠性高（队列保证消息不丢失）
- 容易扩展（增加worker数量即可）
- 与当前架构兼容（Vercel cron → 推送到队列）

**缺点**：
- 需要额外基础设施（Redis/BullMQ）
- 增加运维复杂度

**推荐度**：⭐⭐⭐⭐⭐ (最优方案)

---

#### 方案C: 分层缓存
**优点**：
- 用户体验好（L1快速返回，L2异步补充）
- 压力分散（按需触发enrichment）
- 实施简单

**缺点**：
- 数据一致性复杂（需要处理L1/L2/L3同步）
- 没有根本解决超时问题

**推荐度**：⭐⭐⭐⭐ (可作为B方案的补充)

---

#### 方案D: 渐进式优化
**优点**：
- 风险低
- 渐进式迭代

**缺点**：
- **无法根本解决问题**（已经从360s降到180s仍然超时）
- 治标不治本

**推荐度**：⭐⭐ (不推荐作为主要方案)

---

## 推荐方案：B + C混合架构

### 方案概述
**核心思想**：
1. **Fetch阶段**：保持当前Vercel cron方式（已经工作良好）
2. **Enrich阶段**：引入BullMQ队列 + 后台Worker
3. **缓存阶段**：实施分层缓存（L1/L2/L3）

### 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                          用户请求                                 │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│              Cloudflare CDN (120s timeout)                       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Vercel Edge Function                          │
│              /api/rankings (< 60s)                              │
│  ┌─────────────────────────────────────────────────────┐       │
│  │  L1 Cache: Redis (TTL 60s)                         │       │
│  │    - 只返回基础leaderboard（fetch数据）            │       │
│  │    - arena_score, roi, pnl, drawdown               │       │
│  │    - 不包含enrichment数据                          │       │
│  └─────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                  L2 Cache: Enrichment                            │
│             (异步补充，按需触发)                                  │
│  ┌─────────────────────────────────────────────────────┐       │
│  │  Redis Cache (TTL 3h)                              │       │
│  │    - equity_curve                                  │       │
│  │    - position_history                              │       │
│  │    - stats_detail                                  │       │
│  └─────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              ↑
                              │ (异步补充)
┌─────────────────────────────────────────────────────────────────┐
│              Background Enrichment Pipeline                      │
│                                                                  │
│  Vercel Cron (每4h)                                             │
│       ↓                                                          │
│  batch-fetch-traders (600s)                                     │
│       ↓                                                          │
│  写入DB → 触发enrichment jobs                                    │
│       ↓                                                          │
│  BullMQ Queue (Redis)                                           │
│       ↓                                                          │
│  Background Workers (Railway/Render)                            │
│    - 每个worker处理单个平台                                      │
│    - 无超时限制，可以跑任意长时间                                 │
│    - 并发处理26个平台                                            │
│       ↓                                                          │
│  写入L2 Cache + DB                                              │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│           L3 Cache: Pre-computed Metrics                         │
│              (定期更新，1次/天)                                   │
│  ┌─────────────────────────────────────────────────────┐       │
│  │  - market_correlation                              │       │
│  │  - tier_distribution                               │       │
│  │  - platform_rankings                               │       │
│  └─────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 详细技术设计

### 1. Fetch阶段（保持不变）
**当前方案已经良好工作，无需改动**

```typescript
// app/api/cron/batch-fetch-traders/route.ts
// 保持现有逻辑，仅在fetch完成后触发enrichment job

export async function GET(request: NextRequest) {
  // ... existing fetch logic ...
  
  const results = await Promise.all(platforms.map(runPlatform))
  
  // NEW: 触发enrichment jobs
  for (const result of results) {
    if (result.status === 'success') {
      await triggerEnrichmentJob({
        platform: result.platform,
        period: ['7D', '30D', '90D'],
        priority: getPlatformPriority(result.platform),
      })
    }
  }
}
```

### 2. BullMQ队列架构

**技术选型**：
- **BullMQ** (Redis-based, 比Bull更现代)
- **Redis** (Upstash Redis for serverless, 或Railway Redis for dedicated)

**队列配置**：
```typescript
// lib/queue/enrichment-queue.ts
import { Queue, Worker } from 'bullmq'

// 3个优先级队列
export const HIGH_PRIORITY_QUEUE = new Queue('enrich-high', {
  connection: REDIS_CONNECTION,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100, // 只保留最近100个完成的job
    removeOnFail: 500,
  },
})

export const MEDIUM_PRIORITY_QUEUE = new Queue('enrich-medium', {
  connection: REDIS_CONNECTION,
})

export const LOW_PRIORITY_QUEUE = new Queue('enrich-low', {
  connection: REDIS_CONNECTION,
})

// Job数据结构
interface EnrichmentJob {
  platform: string
  period: '7D' | '30D' | '90D'
  traders: Array<{ trader_id: string; trader_key: string }>
  priority: 'high' | 'medium' | 'low'
}

// 从Vercel cron触发job
export async function triggerEnrichmentJob(data: EnrichmentJob) {
  const queue = data.priority === 'high' 
    ? HIGH_PRIORITY_QUEUE 
    : data.priority === 'medium' 
    ? MEDIUM_PRIORITY_QUEUE 
    : LOW_PRIORITY_QUEUE

  await queue.add(`${data.platform}-${data.period}`, data, {
    jobId: `${data.platform}-${data.period}-${Date.now()}`, // 幂等性
    priority: data.priority === 'high' ? 1 : data.priority === 'medium' ? 5 : 10,
  })
}
```

### 3. Background Worker

**部署方案**：Railway / Render (不是Vercel，因为需要长时间运行)

**Worker架构**：
```typescript
// worker/enrichment-worker.ts
import { Worker } from 'bullmq'
import { runEnrichment } from '@/lib/cron/enrichment-runner'

const worker = new Worker(
  'enrich-high',
  async (job) => {
    const { platform, period, traders } = job.data
    
    console.log(`[Worker] Processing ${platform}/${period} - ${traders.length} traders`)
    
    // 无超时限制！可以跑任意长时间
    const result = await runEnrichment({
      platform,
      period,
      limit: traders.length,
    })
    
    console.log(`[Worker] Completed ${platform}/${period}: ${result.summary.enriched} enriched`)
    
    return result
  },
  {
    connection: REDIS_CONNECTION,
    concurrency: 5, // 每个worker同时处理5个job
    limiter: {
      max: 10, // 每秒最多10个job（API rate limit防护）
      duration: 1000,
    },
  }
)

worker.on('completed', (job) => {
  console.log(`✅ Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
  console.error(`❌ Job ${job?.id} failed:`, err)
})

// 健康检查endpoint（Railway/Render需要）
import express from 'express'
const app = express()
app.get('/health', (req, res) => res.json({ status: 'ok' }))
app.listen(process.env.PORT || 3001)
```

**部署配置**（Railway）：
```yaml
# railway.toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "node worker/enrichment-worker.js"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10

[env]
NODE_ENV = "production"
REDIS_URL = "${{REDIS_URL}}"
DATABASE_URL = "${{DATABASE_URL}}"
```

### 4. 分层缓存实现

**L1 Cache**: 基础leaderboard（只有fetch数据）
```typescript
// app/api/rankings/route.ts
export async function GET(request: NextRequest) {
  const cacheKey = `leaderboard:${window}:${category}:${platform}`
  
  // L1: Redis cache (60s TTL)
  let data = await redis.get(cacheKey)
  if (data) return NextResponse.json(JSON.parse(data))
  
  // L1 miss: 从DB读取基础数据（只有fetch阶段的数据）
  const { data: traders } = await supabase
    .from('trader_snapshots_v2')
    .select('trader_id, trader_key, arena_score, roi, pnl, drawdown')
    .eq('period', window)
    .order('arena_score', { ascending: false })
    .limit(100)
  
  // 写入L1 cache
  await redis.setex(cacheKey, 60, JSON.stringify(traders))
  
  return NextResponse.json({
    data: traders,
    meta: {
      enrichmentStatus: 'pending', // 告诉前端enrichment数据还没准备好
    },
  })
}
```

**L2 Cache**: Enrichment数据（按需触发）
```typescript
// app/api/trader/[id]/equity-curve/route.ts
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const cacheKey = `equity_curve:${params.id}:${period}`
  
  // L2: Redis cache (3h TTL)
  let curve = await redis.get(cacheKey)
  if (curve) return NextResponse.json(JSON.parse(curve))
  
  // L2 miss: 从DB读取
  const { data } = await supabase
    .from('equity_curves')
    .select('*')
    .eq('trader_id', params.id)
    .eq('period', period)
  
  if (data) {
    await redis.setex(cacheKey, 10800, JSON.stringify(data)) // 3h
    return NextResponse.json(data)
  }
  
  // 如果DB也没有，触发on-demand enrichment job（仅针对TOP traders）
  if (isTopTrader(params.id)) {
    await triggerEnrichmentJob({
      platform: getPlatformFromTraderId(params.id),
      period,
      traders: [{ trader_id: params.id, trader_key: getTraderKey(params.id) }],
      priority: 'high', // 按需enrichment优先级最高
    })
  }
  
  return NextResponse.json({ 
    status: 'pending',
    message: 'Enrichment in progress, please retry in 30s',
  })
}
```

**L3 Cache**: 预计算metrics（每天更新）
```typescript
// app/api/cron/precompute-metrics/route.ts
export async function GET() {
  // 计算全局metrics（不受600s限制，因为是后台worker）
  const marketCorrelation = await calculateMarketCorrelation()
  const tierDistribution = await calculateTierDistribution()
  const platformRankings = await calculatePlatformRankings()
  
  // 写入L3 cache (1天TTL)
  await redis.setex('metrics:market_correlation', 86400, JSON.stringify(marketCorrelation))
  await redis.setex('metrics:tier_distribution', 86400, JSON.stringify(tierDistribution))
  await redis.setex('metrics:platform_rankings', 86400, JSON.stringify(platformRankings))
}
```

---

## 技术栈选择

### 核心技术栈
| 组件 | 技术选型 | 理由 |
|------|----------|------|
| **队列** | BullMQ | 现代、可靠、支持优先级 |
| **Redis** | Upstash Redis | Serverless-friendly, 按用量付费 |
| **Worker部署** | Railway | 简单、便宜、支持自动扩展 |
| **数据库** | Supabase (现有) | 无需改动 |
| **前端** | Next.js (现有) | 无需改动 |

### 备选方案
| 组件 | 备选 | 备注 |
|------|------|------|
| Redis | Railway Redis | 如果需要dedicated instance |
| Worker部署 | Render | 类似Railway，更便宜 |
| Worker部署 | AWS ECS | 如果需要更强控制 |

---

## 成本估算

### 基础设施成本（月）

| 服务 | 配置 | 成本 |
|------|------|------|
| **Upstash Redis** | 10GB数据 + 1M commands/day | $40 |
| **Railway Worker** | 2个instance × $5 (512MB RAM) | $10 |
| **Vercel** | Pro Plan (现有) | $20 |
| **Supabase** | Pro Plan (现有) | $25 |
| **总计** | | **$95/月** |

**对比现状**：
- 当前成本：Vercel Pro ($20) + Supabase Pro ($25) = **$45/月**
- 新架构增加成本：**$50/月** (+111%)

**ROI分析**：
- ✅ 根本解决超时问题（worker无超时限制）
- ✅ 可扩展性（增加worker数量即可）
- ✅ 用户体验提升（L1快速返回 + L2异步补充）
- ✅ 数据新鲜度提升（按需enrichment）

### 开发成本（时间）

| 任务 | 工时 | 复杂度 |
|------|------|--------|
| BullMQ队列搭建 | 8h | 中 |
| Worker开发 | 12h | 中 |
| L1/L2缓存实现 | 16h | 高 |
| 监控告警 | 8h | 低 |
| 测试 + 调试 | 16h | 高 |
| **总计** | **60h** | **~2周** |

---

## 风险评估

| 风险 | 严重度 | 概率 | 缓解措施 |
|------|--------|------|----------|
| **Redis成本超支** | 中 | 中 | 设置预算告警；使用Railway Redis作为备选 |
| **Worker失败导致enrichment缺失** | 高 | 低 | BullMQ自动重试；监控告警 |
| **L1/L2数据不一致** | 中 | 中 | 添加version字段；实施cache invalidation策略 |
| **迁移期间服务中断** | 高 | 低 | 灰度发布；保留fallback逻辑 |
| **Worker OOM** | 中 | 中 | 限制batch size；监控内存使用 |

---

## 实施计划

### Phase 1: 基础设施搭建（Week 1）
- [ ] 1.1 搭建Upstash Redis
- [ ] 1.2 搭建BullMQ队列
- [ ] 1.3 开发基础Worker框架
- [ ] 1.4 部署到Railway staging环境
- [ ] 1.5 测试queue → worker流程

### Phase 2: Fetch阶段改造（Week 1）
- [ ] 2.1 修改batch-fetch-traders，添加job trigger逻辑
- [ ] 2.2 测试fetch完成后job是否正确入队
- [ ] 2.3 验证幂等性（重复fetch不会重复enqueue）

### Phase 3: Enrich阶段迁移（Week 2）
- [ ] 3.1 将enrichment-runner逻辑迁移到worker
- [ ] 3.2 添加per-platform timeout控制
- [ ] 3.3 测试单个平台enrichment流程
- [ ] 3.4 测试26个平台并行enrichment
- [ ] 3.5 监控worker性能（内存、CPU、耗时）

### Phase 4: 分层缓存实现（Week 2）
- [ ] 4.1 实现L1 cache（基础leaderboard）
- [ ] 4.2 实现L2 cache（enrichment数据）
- [ ] 4.3 实现按需enrichment触发逻辑
- [ ] 4.4 测试cache hit/miss流程

### Phase 5: 监控与告警（Week 3）
- [ ] 5.1 搭建BullMQ监控面板（bull-board）
- [ ] 5.2 添加Sentry错误追踪
- [ ] 5.3 配置Slack/Email告警
- [ ] 5.4 添加metrics监控（Prometheus可选）

### Phase 6: 灰度发布（Week 3）
- [ ] 6.1 10%流量切到新架构
- [ ] 6.2 监控错误率、响应时间
- [ ] 6.3 50%流量切换
- [ ] 6.4 100%流量切换
- [ ] 6.5 移除旧的batch-enrich cron job

### Phase 7: 优化与迭代（Week 4+）
- [ ] 7.1 根据监控数据优化batch size
- [ ] 7.2 优化cache TTL
- [ ] 7.3 添加更多metrics预计算
- [ ] 7.4 优化worker并发度

---

## 迁移策略（零停机）

### 策略：双轨运行 + Feature Flag

```typescript
// lib/feature-flags.ts
export const USE_QUEUE_ENRICHMENT = process.env.USE_QUEUE_ENRICHMENT === 'true'

// app/api/cron/batch-fetch-traders/route.ts
if (USE_QUEUE_ENRICHMENT) {
  // 新架构：触发BullMQ job
  await triggerEnrichmentJob(data)
} else {
  // 旧架构：直接调用enrichment
  await runEnrichment(data)
}
```

**迁移步骤**：
1. **Week 1-2**: 新架构搭建（USE_QUEUE_ENRICHMENT=false）
2. **Week 3**: 10%流量测试（USE_QUEUE_ENRICHMENT=true for 10% requests）
3. **Week 3**: 50%流量测试
4. **Week 4**: 100%流量切换
5. **Week 4**: 移除旧代码

---

## 监控指标

### 核心指标

| 指标 | 目标 | 告警阈值 |
|------|------|----------|
| **Enrichment完成率** | >98% | <95% |
| **平均enrichment时间** | <5分钟/平台 | >10分钟 |
| **Queue堆积数** | <100 | >500 |
| **Worker错误率** | <1% | >5% |
| **L1 Cache命中率** | >90% | <80% |
| **L2 Cache命中率** | >70% | <50% |
| **API P95响应时间** | <200ms | >500ms |

### 监控面板（可选）
- **BullMQ Board**: 实时查看queue状态
- **Grafana**: 可视化metrics
- **Sentry**: 错误追踪

---

## 成功标准

### 性能指标
- ✅ 100%消除enrichment超时（当前30%超时率 → 0%）
- ✅ API P95响应时间 < 200ms（当前~500ms）
- ✅ L1 cache命中率 > 90%

### 业务指标
- ✅ 数据新鲜度从3-6小时 → 实时（按需enrichment）
- ✅ 支持扩展到50+平台（当前26个）
- ✅ 用户满意度提升（更快响应 + 更新鲜数据）

### 技术指标
- ✅ 代码复杂度增加<20%（新增queue/worker代码）
- ✅ 成本增加<2倍（$45/月 → $95/月）
- ✅ 零停机迁移

---

## 替代方案（如果预算不足）

### 方案C': 分层缓存（无队列）
如果$50/月预算不够，可以只实施分层缓存（不引入BullMQ）：

**架构简化**：
- 保留现有Vercel cron + batch-enrich
- 添加L1/L2 cache
- 优化enrichment策略（只enrich top 100 traders）

**成本**：仅需Upstash Redis ($20/月)

**效果**：
- 部分解决超时问题（减少enrichment量）
- 提升用户体验（L1快速返回）
- **但无法根本解决600s超时限制**

---

## 总结

### 推荐方案：B (队列 + Worker) + C (分层缓存)

**为什么推荐**：
1. **根本解决超时问题**（worker无超时限制）
2. **可扩展**（增加worker即可）
3. **用户体验好**（L1快速 + L2异步）
4. **成本可控**（$50/月增量）
5. **风险可控**（灰度发布 + feature flag）

**关键决策点**：
- ✅ 使用BullMQ而非自己实现队列（成熟可靠）
- ✅ Worker部署在Railway而非Vercel（需要长时间运行）
- ✅ 分层缓存而非单层缓存（平衡速度和新鲜度）
- ✅ 灰度发布而非一次性切换（降低风险）

**预期效果**：
- 超时率：30% → **0%**
- API响应时间：500ms → **<200ms**
- 数据新鲜度：3-6h → **实时**
- 扩展性：26平台 → **50+平台**

**ROI**：
- 投入：2周开发 + $50/月运维
- 收益：根本解决核心痛点 + 显著提升用户体验 + 支撑未来增长

**下一步**：开始Phase 1 基础设施搭建 🚀
