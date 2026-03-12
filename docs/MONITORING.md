# Connector Monitoring - 监控和告警

## 概述

统一 Connector 框架提供了完整的监控和告警体系，包括：

- **Redis 状态存储** - 实时状态查询
- **Pipeline 日志** - 历史执行记录
- **Telegram 告警** - 异常情况通知
- **健康检查** - 系统健康度监控

## 监控架构

```
┌──────────────────────────────────────────────────┐
│              Data Collection                      │
│  ConnectorRunner → Redis + PipelineLogger        │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────┐
│              Storage Layer                        │
│  ┌────────────┐  ┌──────────────────────────┐    │
│  │   Redis    │  │   Supabase (Postgres)    │    │
│  │connector:  │  │   - pipeline_logs        │    │
│  │ status:*   │  │   - pipeline_job_status  │    │
│  └────────────┘  │   - pipeline_job_stats   │    │
│                  └──────────────────────────┘    │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────┐
│              Alerting                             │
│  Telegram (Critical/Warning alerts)              │
└──────────────────────────────────────────────────┘
```

## 1. Redis 状态监控

### 状态查询

**查询单个平台状态**:

```typescript
import { ConnectorRunner } from '@/lib/connectors/connector-runner'
import { HyperliquidConnector } from '@/lib/connectors/hyperliquid'

const connector = new HyperliquidConnector()
const runner = new ConnectorRunner(connector, { platform: 'hyperliquid' })

const status = await runner.getStatus()

console.log(status)
// {
//   platform: 'hyperliquid',
//   lastRun: '2026-03-11T19:30:00Z',
//   status: 'success',
//   recordsProcessed: 150,
//   consecutiveFailures: 0,
//   errors: 0
// }
```

**查询所有平台状态**:

```typescript
import { getAllConnectorStatuses } from '@/lib/connectors/connector-runner'

const platforms = ['hyperliquid', 'binance', 'okx', 'bitget']
const statuses = await getAllConnectorStatuses(platforms)

// 过滤失败的平台
const failed = statuses.filter(s => s.status === 'error')
console.log(`失败平台: ${failed.length}/${statuses.length}`)

failed.forEach(s => {
  console.log(`${s.platform}: ${s.lastError}`)
})
```

### 状态字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `platform` | string | 平台名称 |
| `lastRun` | ISO 8601 | 最后运行时间 |
| `status` | `success` \| `error` \| `running` | 当前状态 |
| `recordsProcessed` | number | 处理的记录数 |
| `errors` | number | 错误次数 |
| `consecutiveFailures` | number | **连续失败次数**（告警关键指标） |
| `lastError` | string | 最后错误信息 |
| `nextRetry` | ISO 8601 | 下次重试时间（失败时） |
| `metadata` | object | 额外元数据（执行时长、参数等） |

### Dashboard 示例

创建一个简单的监控 Dashboard:

```typescript
// app/api/admin/connector-dashboard/route.ts

import { getAllConnectorStatuses } from '@/lib/connectors/connector-runner'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export async function GET() {
  const platforms = ['hyperliquid', 'binance', 'okx', 'bitget', 'gmx', 'dydx']
  
  // 1. 获取 Redis 状态
  const statuses = await getAllConnectorStatuses(platforms)
  
  // 2. 获取 Pipeline 统计
  const stats = await PipelineLogger.getJobStats()
  
  // 3. 获取最近失败
  const failures = await PipelineLogger.getRecentFailures(10)
  
  // 4. 计算健康度
  const healthy = statuses.filter(s => s.status === 'success' && s.consecutiveFailures === 0).length
  const healthRate = (healthy / statuses.length * 100).toFixed(1)
  
  return Response.json({
    summary: {
      total: statuses.length,
      healthy,
      unhealthy: statuses.length - healthy,
      healthRate: `${healthRate}%`,
    },
    statuses,
    stats,
    failures,
  })
}
```

访问: `https://ranking-arena.vercel.app/api/admin/connector-dashboard`

## 2. Pipeline 日志监控

### 数据库表

**`pipeline_logs`** - 每次执行的详细日志

```sql
SELECT
  job_name,
  status,
  started_at,
  ended_at,
  records_processed,
  error_message,
  metadata
FROM pipeline_logs
WHERE job_name LIKE '%-connector'
ORDER BY started_at DESC
LIMIT 20;
```

**`pipeline_job_status`** (视图) - 每个 job 的最新状态

```sql
SELECT
  job_name,
  started_at,
  status,
  records_processed,
  error_message,
  health_status
FROM pipeline_job_status
ORDER BY started_at DESC;
```

**`pipeline_job_stats`** (视图) - 过去 7 天的统计

```sql
SELECT
  job_name,
  total_runs,
  success_count,
  error_count,
  success_rate,
  avg_duration_ms,
  last_run_at
FROM pipeline_job_stats
WHERE job_name LIKE '%-connector'
ORDER BY success_rate ASC;
```

### 查询 API

**获取 Job 状态**:

```typescript
import { PipelineLogger } from '@/lib/services/pipeline-logger'

const statuses = await PipelineLogger.getJobStatuses()

statuses.forEach(job => {
  console.log(`${job.job_name}: ${job.status} (${job.health_status})`)
})
```

**获取 Job 统计**:

```typescript
const stats = await PipelineLogger.getJobStats()

stats.forEach(job => {
  console.log(`${job.job_name}:`)
  console.log(`  成功率: ${job.success_rate}%`)
  console.log(`  平均耗时: ${job.avg_duration_ms}ms`)
  console.log(`  最后运行: ${job.last_run_at}`)
})
```

**获取最近失败**:

```typescript
const failures = await PipelineLogger.getRecentFailures(20)

failures.forEach(f => {
  console.log(`${f.job_name} @ ${f.started_at}:`)
  console.log(`  ${f.error_message}`)
})
```

**获取连续失败次数**:

```typescript
const count = await PipelineLogger.getConsecutiveFailures('hyperliquid-connector')

if (count >= 3) {
  console.log(`⚠️ hyperliquid 连续失败 ${count} 次`)
}
```

## 3. Telegram 告警

### 告警级别

| 级别 | 触发条件 | 示例 |
|------|----------|------|
| `critical` | 连续失败 ≥3 次 | "hyperliquid 连续失败 3 次" |
| `warning` | 0 结果、响应慢 (>10s)、数据缺失 >50% | "hyperliquid 返回 0 结果" |
| `info` | 批量执行摘要（全部成功） | 通常不发送 |

### 告警格式

**CRITICAL 告警**:
```
🔴 hyperliquid 连续失败 3 次

错误: Timeout after 60000ms

详情:
- 平台: hyperliquid
- 连续失败次数: 3
- 最后错误: Timeout after 60000ms
- 参数: {"window":"90d"}
```

**WARNING 告警**:
```
⚠️ hyperliquid 返回 0 结果

可能是 API 问题或查询参数错误
```

**响应慢告警**:
```
⚠️ hyperliquid 响应慢

耗时 12.3s，可能需要优化

详情:
- 耗时: 12.3s
```

### 限流规则

- **同一平台、同一级别**: 5 分钟内只发送 1 次
- **聚合告警**: 1 分钟内相同告警聚合为 1 条

### 配置告警

**启用/禁用告警**:

```typescript
const runner = new ConnectorRunner(connector, {
  platform: 'hyperliquid',
  enableAlerts: true, // 默认 true
  alertThreshold: 3,  // 连续失败阈值，默认 3
})
```

**手动发送测试告警**:

```typescript
import { sendAlert } from '@/lib/alerts/send-alert'

await sendAlert({
  title: '测试告警',
  message: '这是一条测试消息',
  level: 'info',
})
```

## 4. 健康检查 API

### Endpoint

```
GET /api/admin/connector-health
```

### 返回示例

```json
{
  "overall": {
    "healthy": 8,
    "unhealthy": 2,
    "total": 10,
    "healthRate": "80%"
  },
  "platforms": [
    {
      "platform": "hyperliquid",
      "status": "success",
      "lastRun": "2026-03-11T19:30:00Z",
      "consecutiveFailures": 0,
      "health": "healthy"
    },
    {
      "platform": "binance",
      "status": "error",
      "lastRun": "2026-03-11T18:45:00Z",
      "consecutiveFailures": 2,
      "lastError": "Timeout after 60000ms",
      "health": "degraded"
    }
  ]
}
```

### 实现

```typescript
// app/api/admin/connector-health/route.ts

import { getAllConnectorStatuses } from '@/lib/connectors/connector-runner'

export async function GET() {
  const platforms = ['hyperliquid', 'binance', 'okx', 'bitget', 'gmx', 'dydx']
  const statuses = await getAllConnectorStatuses(platforms)

  const platformHealth = statuses.map(s => ({
    platform: s.platform,
    status: s.status,
    lastRun: s.lastRun,
    consecutiveFailures: s.consecutiveFailures,
    lastError: s.lastError,
    health: s.status === 'success' && s.consecutiveFailures === 0
      ? 'healthy'
      : s.consecutiveFailures >= 3
      ? 'critical'
      : 'degraded',
  }))

  const healthy = platformHealth.filter(p => p.health === 'healthy').length
  const unhealthy = platformHealth.filter(p => p.health !== 'healthy').length

  return Response.json({
    overall: {
      healthy,
      unhealthy,
      total: platforms.length,
      healthRate: `${(healthy / platforms.length * 100).toFixed(1)}%`,
    },
    platforms: platformHealth,
  })
}
```

## 5. 性能监控

### 关键指标

| 指标 | 阈值 | 告警级别 |
|------|------|----------|
| **执行时长** | >10s | WARNING |
| **执行时长** | >60s | CRITICAL (timeout) |
| **成功率** | <80% (7天) | WARNING |
| **成功率** | <50% (7天) | CRITICAL |
| **连续失败** | ≥3 次 | CRITICAL |
| **返回结果** | 0 条 | WARNING |

### 查询慢查询

```sql
-- 查找执行时长 >10s 的任务
SELECT
  job_name,
  started_at,
  (EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000) AS duration_ms,
  records_processed
FROM pipeline_logs
WHERE status = 'success'
  AND ended_at IS NOT NULL
  AND (EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000) > 10000
ORDER BY duration_ms DESC
LIMIT 20;
```

### 性能优化建议

1. **并发控制**: 增加 `maxConcurrent` 如果 API 允许
2. **Rate limiting**: 调整 `delayMs` 平衡速度和风险
3. **Timeout**: 根据平台调整 `timeoutMs`
4. **缓存**: 使用 Redis 缓存中间结果

## 6. 告警响应流程

### 连续失败告警

1. **收到告警**: "hyperliquid 连续失败 3 次"
2. **查看 Redis 状态**:
   ```typescript
   const status = await runner.getStatus()
   console.log(status.lastError)
   ```
3. **查看 Pipeline 日志**:
   ```sql
   SELECT * FROM pipeline_logs
   WHERE job_name = 'hyperliquid-connector'
   ORDER BY started_at DESC LIMIT 5;
   ```
4. **分析原因**:
   - Timeout? → 增加 `timeoutMs`
   - API 错误? → 检查 API 状态
   - Rate limit? → 减少 `maxConcurrent`
5. **修复并测试**:
   ```bash
   curl "https://ranking-arena.vercel.app/api/cron/unified-connector?platform=hyperliquid&dryRun=true"
   ```
6. **清除状态**:
   ```typescript
   await runner.clearStatus()
   ```

### 0 结果告警

1. **收到告警**: "hyperliquid 返回 0 结果"
2. **手动调用 API 测试**:
   ```bash
   curl "https://api.hyperliquid.xyz/info" \
     -d '{"type":"leaderboard","timeWindow":"allTime"}'
   ```
3. **检查参数**:
   - 时间窗口正确？
   - 排序参数正确？
4. **修复代码**
5. **重新运行**

## 7. 定期巡检

### 每日检查

```bash
# 1. 查看所有平台状态
curl "https://ranking-arena.vercel.app/api/admin/connector-health"

# 2. 查看最近失败
SELECT * FROM pipeline_logs
WHERE status IN ('error', 'timeout')
  AND started_at > NOW() - INTERVAL '24 hours'
ORDER BY started_at DESC;

# 3. 查看成功率
SELECT * FROM pipeline_job_stats
WHERE job_name LIKE '%-connector'
  AND success_rate < 90
ORDER BY success_rate ASC;
```

### 每周报告

- 总执行次数
- 成功率趋势
- 平均执行时长
- Top 5 失败原因
- 性能优化建议

## 8. 工具和脚本

### 清除所有状态

```typescript
// scripts/clear-connector-status.ts

import { clearAllConnectorStatuses } from '@/lib/connectors/connector-runner'

const platforms = ['hyperliquid', 'binance', 'okx', 'bitget']
const cleared = await clearAllConnectorStatuses(platforms)

console.log(`清除 ${cleared} 个平台状态`)
```

### 批量重跑失败任务

```typescript
// scripts/retry-failed-connectors.ts

import { getAllConnectorStatuses, ConnectorRunner } from '@/lib/connectors/connector-runner'
import { HyperliquidConnector } from '@/lib/connectors/hyperliquid'

const statuses = await getAllConnectorStatuses(['hyperliquid', 'binance'])
const failed = statuses.filter(s => s.status === 'error')

for (const status of failed) {
  console.log(`重跑 ${status.platform}...`)
  
  // 根据平台创建 connector
  const connector = createConnector(status.platform)
  const runner = new ConnectorRunner(connector, { platform: status.platform })
  
  await runner.execute({ window: '90d' })
}
```

## 相关文档

- [架构设计](./CONNECTOR_ARCHITECTURE.md)
- [迁移指南](./MIGRATION_GUIDE.md)
