# Connector Framework - 统一数据采集框架

> **Status**: 🚧 Phase 1 完成 (基础设施) - Phase 2 进行中 (平台迁移)

## 概述

统一的 Connector 框架用于从各个交易所/协议采集数据，集成了：

- ✅ **Redis 状态存储** - 实时状态查询
- ✅ **PipelineLogger 集成** - 历史执行记录
- ✅ **Telegram 告警** - 异常情况通知（连续失败、0 结果、响应慢）
- ✅ **统一错误处理** - 3 次重试 + 指数退避
- ✅ **Rate limiting** - 防止被 ban
- ✅ **Timeout 配置** - 每个 API 不同超时

## 快速开始

### 1. 使用现有 Connector

```typescript
import { ConnectorRunner } from '@/lib/connectors/connector-runner'
import { HyperliquidConnector } from '@/lib/connectors/hyperliquid'

// 1. 创建 connector
const connector = new HyperliquidConnector()

// 2. 包装到 Runner
const runner = new ConnectorRunner(connector, {
  platform: 'hyperliquid',
  enableAlerts: true,
  alertThreshold: 3,
})

// 3. 执行
const result = await runner.execute({ window: '90d' })

console.log(`Success: ${result.success}`)
console.log(`Records: ${result.recordsProcessed}`)

// 4. 查询状态
const status = await runner.getStatus()
console.log(`Status: ${status?.status}`)
console.log(`Consecutive failures: ${status?.consecutiveFailures}`)
```

### 2. 通过 API 调用

```bash
# 单个平台
curl "https://ranking-arena.vercel.app/api/cron/unified-connector?platform=hyperliquid&window=90d"

# 所有平台
curl "https://ranking-arena.vercel.app/api/cron/unified-connector?platform=all"

# 测试模式
curl "http://localhost:3000/api/cron/unified-connector?platform=hyperliquid&dryRun=true"
```

### 3. 本地测试

```bash
# 安装依赖
npm install

# 运行测试脚本
tsx scripts/test-connector-framework.ts

# 指定平台和参数
tsx scripts/test-connector-framework.ts --platform=hyperliquid --window=90d --dry-run
```

## 核心组件

### ConnectorRunner (`lib/connectors/connector-runner.ts`)

**职责**：
- 包装任何现有 Connector
- 添加监控和日志
- Redis 状态管理
- Telegram 告警
- 超时和重试控制

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

### Unified Cron Endpoint (`app/api/cron/unified-connector/route.ts`)

**支持的平台**（当前）：
- ✅ Hyperliquid

**待迁移**：
- 📋 Binance Futures
- 📋 OKX Futures
- 📋 Bitget Futures
- 📋 HTX Futures
- 📋 GMX
- 📋 dYdX
- 📋 Gains Network
- 📋 Aevo
- 📋 Drift
- 📋 Jupiter Perps

**参数**：
- `platform`: 平台名称 或 `all`
- `window`: 时间窗口 (`7d`, `30d`, `90d`)
- `page`: 分页页码
- `pageSize`: 每页记录数
- `dryRun`: 测试模式

## Redis 状态 Schema

**Key**: `connector:status:{platform}`

```typescript
interface ConnectorStatus {
  platform: string
  lastRun: string              // ISO 8601
  status: 'success' | 'error' | 'running'
  recordsProcessed: number
  errors: number
  consecutiveFailures: number  // ⚠️ 关键指标
  lastError?: string
  nextRetry?: string
  metadata?: Record<string, unknown>
}
```

## Telegram 告警触发条件

1. **连续失败 ≥3 次** → 🔴 CRITICAL
   ```
   🔴 hyperliquid 连续失败 3 次
   错误: Timeout after 60000ms
   ```

2. **返回 0 结果** → ⚠️ WARNING
   ```
   ⚠️ hyperliquid 返回 0 结果
   可能是 API 问题或查询参数错误
   ```

3. **响应时间 >10s** → ⚠️ WARNING
   ```
   ⚠️ hyperliquid 响应慢
   耗时 12.3s，可能需要优化
   ```

## 迁移进度

### Phase 1: 基础设施 ✅

- [x] ConnectorRunner
- [x] unified-connector API endpoint
- [x] Redis 状态存储
- [x] PipelineLogger 集成
- [x] Telegram 告警集成
- [x] 文档（架构、迁移、监控）
- [x] 测试脚本

### Phase 2: 试点平台 🔄

- [ ] Hyperliquid
  - [x] Connector 已存在
  - [ ] 包装到 Runner
  - [ ] 配置 Vercel Cron
  - [ ] 灰度测试
  - [ ] 监控 1 周

### Phase 3: CEX 平台 📋

- [ ] Binance Futures
- [ ] OKX Futures
- [ ] Bitget Futures
- [ ] HTX Futures

### Phase 4: Onchain 平台 📋

- [ ] GMX
- [ ] dYdX
- [ ] Gains Network
- [ ] Aevo
- [ ] Drift
- [ ] Jupiter Perps

### Phase 5: 清理 📋

- [ ] 移除旧脚本
- [ ] 更新文档
- [ ] 性能优化

## 监控和维护

### 查询所有平台状态

```typescript
import { getAllConnectorStatuses } from '@/lib/connectors/connector-runner'

const statuses = await getAllConnectorStatuses([
  'hyperliquid',
  'binance',
  'okx',
])

// 检查失败的平台
const failed = statuses.filter(s => s.status === 'error')
console.log(`失败平台: ${failed.length}/${statuses.length}`)
```

### 查询 Pipeline 日志

```typescript
import { PipelineLogger } from '@/lib/services/pipeline-logger'

// 获取最近失败
const failures = await PipelineLogger.getRecentFailures(20)

// 获取连续失败次数
const count = await PipelineLogger.getConsecutiveFailures('hyperliquid-connector')

// 获取统计
const stats = await PipelineLogger.getJobStats()
```

### 健康检查 API

```bash
curl "https://ranking-arena.vercel.app/api/admin/connector-health"
```

返回：
```json
{
  "overall": {
    "healthy": 8,
    "unhealthy": 2,
    "total": 10,
    "healthRate": "80%"
  },
  "platforms": [...]
}
```

## 文档

- **[架构设计](./docs/CONNECTOR_ARCHITECTURE.md)** - 完整架构和设计原理
- **[迁移指南](./docs/MIGRATION_GUIDE.md)** - 详细迁移步骤
- **[监控和告警](./docs/MONITORING.md)** - 监控体系和告警配置

## 测试

```bash
# 运行完整测试套件
tsx scripts/test-connector-framework.ts

# 指定平台测试
tsx scripts/test-connector-framework.ts --platform=hyperliquid

# 禁用告警
tsx scripts/test-connector-framework.ts --no-alerts

# Dry-run 模式
tsx scripts/test-connector-framework.ts --dry-run
```

## 添加新平台

1. **实现 Connector**（或使用现有的）
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

## 故障排查

### 连续失败告警

1. 查看 Redis 状态: `runner.getStatus()`
2. 查看 Pipeline 日志: `PipelineLogger.getRecentFailures()`
3. 分析原因（Timeout、API 错误、Rate limit）
4. 调整配置（`timeoutMs`, `maxRetries`, `maxConcurrent`）
5. 重新运行

### 0 结果返回

1. 手动调用 API 测试
2. 检查参数（时间窗口、排序等）
3. 修复代码
4. 重新运行

## 性能优化

- **并发控制**: 调整 `maxConcurrent`
- **Rate limiting**: 调整 `delayMs`
- **Timeout**: 根据平台调整 `timeoutMs`
- **缓存**: 使用 Redis 缓存中间结果

## 贡献

- 报告 Bug: GitHub Issues
- 添加新平台: 遵循迁移指南
- 优化性能: 提交 PR

---

**Last Updated**: 2026-03-11
**Status**: Phase 1 完成，Phase 2 进行中
**Next Steps**: 完成 Hyperliquid 试点迁移
