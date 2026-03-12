# Connector Architecture - 统一数据采集框架

## 概述

统一的 Connector 框架用于从各个交易所/协议采集数据，集成了监控、告警、错误处理和状态管理。

## 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    Vercel Cron Jobs                          │
│              /api/cron/unified-connector                     │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                  ConnectorRunner                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  1. PipelineLogger.start()    (记录到 DB)            │   │
│  │  2. Redis: 写入 'running' 状态                        │   │
│  │  3. Execute connector logic                          │   │
│  │  4. Check warnings (0 results, slow response)        │   │
│  │  5. PipelineLogger.success/error()                   │   │
│  │  6. Redis: 写入 'success'/'error' 状态                │   │
│  │  7. Telegram alert (if consecutive failures > 3)     │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Platform Connectors                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Hyperliquid  │  │   Binance    │  │     OKX      │      │
│  │  Connector   │  │   Futures    │  │   Futures    │ ...  │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                External APIs                                 │
│   Hyperliquid API  |  Binance API  |  OKX API  | ...        │
└─────────────────────────────────────────────────────────────┘

Storage:
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Supabase    │    │    Redis     │    │   Telegram   │
│ pipeline_logs│    │connector:    │    │   Alerts     │
│              │    │  status:*    │    │              │
└──────────────┘    └──────────────┘    └──────────────┘
```

## 核心组件

### 1. ConnectorRunner (`lib/connectors/connector-runner.ts`)

**职责**：
- 包装任何现有 Connector
- 添加监控和日志
- Redis 状态管理
- Telegram 告警
- 超时和重试控制

**接口**：
```typescript
class ConnectorRunner<T> {
  constructor(connector: T, config: RunnerConfig)
  async execute(params?: ExecuteParams): Promise<ExecuteResult>
  async getStatus(): Promise<ConnectorStatus | null>
}
```

**配置**：
```typescript
interface RunnerConfig {
  platform: string           // 平台名称
  enableAlerts?: boolean     // 启用告警 (默认 true)
  alertThreshold?: number    // 连续失败阈值 (默认 3)
  timeoutMs?: number         // 超时时间 (默认 60s)
  maxRetries?: number        // 最大重试次数 (默认 3)
  backoffMultiplier?: number // 退避倍数 (默认 2)
}
```

### 2. Platform Connectors

**现有 Connectors**（需要包装）：
- `HyperliquidConnector` - ✅ 已支持
- `BinanceFuturesConnector` - 待迁移
- `OKXConnector` - 待迁移
- `BitgetFuturesConnector` - 待迁移
- 更多见 `lib/connectors/`

**接口要求**：
Connector 必须实现以下方法之一：
- `discoverLeaderboard(window: RankingWindow): Promise<TraderIdentity[]>` (Legacy)
- `getTraderList(params): Promise<TraderData[]>` (New)

### 3. Unified Cron Endpoint (`app/api/cron/unified-connector/route.ts`)

**URL**:
```
GET /api/cron/unified-connector?platform=<platform>&window=<window>
```

**参数**:
- `platform`: 平台名称 (`hyperliquid`, `binance`, `okx`) 或 `all`
- `window`: 时间窗口 (`7d`, `30d`, `90d`) - 默认 `90d`
- `page`: 分页页码 (可选)
- `pageSize`: 每页记录数 (可选)
- `dryRun`: 测试模式，不保存到 DB (可选)

**示例**:
```bash
# 单个平台
curl "https://ranking-arena.vercel.app/api/cron/unified-connector?platform=hyperliquid&window=90d"

# 所有平台
curl "https://ranking-arena.vercel.app/api/cron/unified-connector?platform=all"

# 测试模式
curl "https://ranking-arena.vercel.app/api/cron/unified-connector?platform=hyperliquid&dryRun=true"
```

**返回**:
```json
{
  "platform": "hyperliquid",
  "params": { "window": "90d", "page": 1, "pageSize": 100 },
  "result": {
    "success": true,
    "recordsProcessed": 150,
    "errors": [],
    "durationMs": 2500
  },
  "status": {
    "platform": "hyperliquid",
    "lastRun": "2026-03-11T19:30:00Z",
    "status": "success",
    "recordsProcessed": 150,
    "consecutiveFailures": 0
  },
  "timestamp": "2026-03-11T19:30:00Z"
}
```

## Redis 状态 Schema

**Key Pattern**: `connector:status:{platform}`

**数据结构**:
```typescript
interface ConnectorStatus {
  platform: string              // 平台名称
  lastRun: string              // 最后运行时间 (ISO 8601)
  status: 'success' | 'error' | 'running'
  recordsProcessed: number     // 处理的记录数
  errors: number               // 错误次数
  consecutiveFailures: number  // 连续失败次数
  lastError?: string           // 最后错误信息
  nextRetry?: string           // 下次重试时间 (ISO 8601)
  metadata?: Record<string, unknown> // 额外元数据
}
```

**示例**:
```json
{
  "platform": "hyperliquid",
  "lastRun": "2026-03-11T19:30:00Z",
  "status": "success",
  "recordsProcessed": 150,
  "errors": 0,
  "consecutiveFailures": 0,
  "metadata": {
    "durationMs": 2500,
    "params": { "window": "90d" }
  }
}
```

## Telegram 告警

### 触发条件

1. **连续失败 ≥3 次** → CRITICAL 告警
   ```
   🔴 hyperliquid 连续失败 3 次
   错误: Timeout after 60000ms
   平台: hyperliquid
   连续失败次数: 3
   参数: {"window":"90d"}
   ```

2. **返回 0 结果** → WARNING
   ```
   ⚠️ hyperliquid 返回 0 结果
   可能是 API 问题或查询参数错误
   ```

3. **响应时间 >10s** → WARNING
   ```
   ⚠️ hyperliquid 响应慢
   耗时 12.3s，可能需要优化
   ```

### 限流规则

- 同一平台、同一告警级别：5 分钟内只发送 1 次
- 防止告警轰炸

## Pipeline 日志

**表**: `pipeline_logs`

**字段**:
```sql
CREATE TABLE pipeline_logs (
  id BIGSERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL, -- 'running', 'success', 'error', 'timeout'
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  records_processed INT DEFAULT 0,
  error_message TEXT,
  metadata JSONB
);
```

**视图**: `pipeline_job_status` - 每个 job 的最新状态
**视图**: `pipeline_job_stats` - 过去 7 天的统计

## 错误处理

### 重试策略

1. **Exponential Backoff**: 初始延迟 200ms，每次重试翻倍
2. **最大重试**: 默认 3 次
3. **超时**: 默认 60s

**示例**:
```
Attempt 1: Failed → wait 200ms
Attempt 2: Failed → wait 400ms
Attempt 3: Failed → wait 800ms
Attempt 4: Failed → 放弃，记录错误
```

### Rate Limiting

- 每个平台独立的 rate limiter
- 默认：1 并发，200ms 延迟
- 可配置：`maxConcurrent`, `delayMs`

## 性能优化

### 并发控制

- 单平台执行：顺序执行（防止被 ban）
- 多平台执行：最多 3 个平台并发

### 缓存策略

- Redis 状态缓存：warm tier (15 分钟 TTL)
- 支持批量查询状态

## 监控和维护

### 健康检查

**查询所有平台状态**:
```typescript
import { getAllConnectorStatuses } from '@/lib/connectors/connector-runner'

const statuses = await getAllConnectorStatuses([
  'hyperliquid',
  'binance',
  'okx',
])

// 检查失败的平台
const failed = statuses.filter(s => s.status === 'error')
```

### 清除状态

```typescript
import { clearAllConnectorStatuses } from '@/lib/connectors/connector-runner'

await clearAllConnectorStatuses(['hyperliquid'])
```

### Pipeline 日志查询

```typescript
import { PipelineLogger } from '@/lib/services/pipeline-logger'

// 获取最近失败
const failures = await PipelineLogger.getRecentFailures(20)

// 获取连续失败次数
const count = await PipelineLogger.getConsecutiveFailures('hyperliquid-connector')

// 获取统计
const stats = await PipelineLogger.getJobStats()
```

## 扩展新平台

### 步骤

1. **实现 Connector**:
   ```typescript
   export class NewPlatformConnector implements PlatformConnector {
     async discoverLeaderboard(window: RankingWindow) {
       // 实现逻辑
     }
   }
   ```

2. **注册到 unified-connector**:
   ```typescript
   // app/api/cron/unified-connector/route.ts
   const PLATFORM_CONNECTORS = {
     ...
     newplatform: () => new NewPlatformConnector(),
   }
   ```

3. **配置 Vercel Cron**:
   ```json
   {
     "crons": [{
       "path": "/api/cron/unified-connector?platform=newplatform&window=90d",
       "schedule": "0 */6 * * *"
     }]
   }
   ```

4. **测试**:
   ```bash
   curl "http://localhost:3000/api/cron/unified-connector?platform=newplatform&dryRun=true"
   ```

## 最佳实践

1. **向后兼容**: 新 Connector 必须产出相同数据格式
2. **零停机迁移**: 逐步替换，保持现有 cron jobs 运行
3. **错误容忍**: 单个平台失败不影响其他平台
4. **性能**: 不能比现有脚本慢
5. **监控优先**: 每个新平台都必须有告警

## 相关文档

- [迁移指南](./MIGRATION_GUIDE.md)
- [监控和告警](./MONITORING.md)
