# Connector Migration Guide - 迁移指南

## 目标

将现有的独立数据采集脚本（`scripts/import/import_*.mjs`）迁移到统一的 Connector 框架。

## 迁移原则

1. **零停机迁移** - 逐步替换，保持现有 cron jobs 运行
2. **向后兼容** - 新 Connector 必须产出相同数据格式
3. **错误容忍** - 单个平台失败不影响其他平台
4. **性能优先** - 不能比现有脚本慢
5. **监控优先** - 每个平台都必须有告警

## 迁移路线图

### Phase 1: 基础设施 (P0) ✅

- [x] 创建 `ConnectorRunner`
- [x] 创建 `unified-connector` API endpoint
- [x] 集成 Redis 状态存储
- [x] 集成 PipelineLogger
- [x] 集成 Telegram 告警

### Phase 2: 试点平台 (P0) 🔄

**目标**: 迁移 1-2 个小平台验证框架

- [ ] Hyperliquid
  - [x] Connector 已存在 (`lib/connectors/hyperliquid.ts`)
  - [ ] 包装到 ConnectorRunner
  - [ ] 配置 Vercel Cron
  - [ ] 灰度测试（dry-run）
  - [ ] 切换到新 endpoint
  - [ ] 监控 1 周

- [ ] GMX (小平台，风险低)
  - [ ] 实现 GMXConnector
  - [ ] 测试
  - [ ] 部署

### Phase 3: CEX 平台 (P0) 📋

**目标**: 迁移主要中心化交易所

- [ ] Binance Futures
  - [x] Connector 已存在 (`lib/connectors/binance-futures.ts`)
  - [ ] 包装到 ConnectorRunner
  - [ ] 配置 Vercel Cron
  - [ ] 切换

- [ ] OKX Futures
  - [x] Connector 已存在 (`lib/connectors/okx.ts`)
  - [ ] 包装到 ConnectorRunner
  - [ ] 配置 Vercel Cron
  - [ ] 切换

- [ ] Bitget Futures
  - [x] Connector 已存在 (`lib/connectors/bitget-futures.ts`)
  - [ ] 包装到 ConnectorRunner
  - [ ] 配置 Vercel Cron
  - [ ] 切换

- [ ] HTX Futures
  - [ ] 创建 HTXFuturesConnector
  - [ ] 测试
  - [ ] 部署

### Phase 4: Onchain 平台 (P1) 📋

- [ ] dYdX
- [ ] Gains Network
- [ ] Aevo
- [ ] Drift
- [ ] Jupiter Perps

### Phase 5: 清理和优化 (P2) 📋

- [ ] 移除旧脚本（`scripts/import/import_*.mjs`）
- [ ] 移除 enrichment 脚本（`scripts/import/enrich_*.mjs`）
- [ ] 更新文档
- [ ] 性能优化

## 详细迁移步骤

### Step 1: 创建或验证 Connector

#### 1.1 检查现有 Connector

```bash
ls lib/connectors/ | grep -i <platform>
```

如果已存在，跳到 Step 2。否则，创建新 Connector：

#### 1.2 创建新 Connector（模板）

```typescript
// lib/connectors/platforms/<platform>-connector.ts

import { BaseConnectorLegacy } from '../base'
import type { RankingWindow, TraderIdentity } from '@/lib/types/leaderboard'

export class NewPlatformConnector extends BaseConnectorLegacy {
  readonly platform = 'newplatform' as const
  private readonly apiUrl = 'https://api.newplatform.com'

  async discoverLeaderboard(window: RankingWindow): Promise<TraderIdentity[]> {
    const traders: TraderIdentity[] = []
    
    // 1. Fetch data from API
    const data = await this.requestWithCircuitBreaker(
      () => this.fetchLeaderboard(window),
      { label: `discoverLeaderboard(${window})` }
    )
    
    // 2. Transform to TraderIdentity
    for (const entry of data) {
      traders.push({
        platform: this.platform,
        trader_key: entry.id,
        display_name: entry.name,
        avatar_url: entry.avatar,
        profile_url: `https://newplatform.com/trader/${entry.id}`,
        discovered_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
      })
    }
    
    return traders
  }
  
  private async fetchLeaderboard(window: RankingWindow): Promise<any[]> {
    const response = await fetch(`${this.apiUrl}/leaderboard?period=${window}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }
}
```

#### 1.3 测试 Connector

```typescript
// test-connector.ts
import { NewPlatformConnector } from './lib/connectors/platforms/newplatform-connector'

const connector = new NewPlatformConnector()
const traders = await connector.discoverLeaderboard('90d')
console.log(`Found ${traders.length} traders`)
```

```bash
tsx test-connector.ts
```

### Step 2: 注册到 unified-connector

编辑 `app/api/cron/unified-connector/route.ts`:

```typescript
const PLATFORM_CONNECTORS = {
  hyperliquid: () => new HyperliquidConnector(),
  newplatform: () => new NewPlatformConnector(), // 👈 添加这里
  ...
}
```

### Step 3: 本地测试

```bash
# 启动开发服务器
npm run dev

# 测试单个平台
curl "http://localhost:3000/api/cron/unified-connector?platform=newplatform&window=90d&dryRun=true"

# 查看返回结果
# - result.success 应该为 true
# - result.recordsProcessed > 0
# - status.status 应该为 'success'
```

### Step 4: 部署到 Vercel

```bash
# 提交代码
git add .
git commit -m "feat: add NewPlatform connector"
git push

# Vercel 自动部署
```

### Step 5: 配置 Vercel Cron

编辑 `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/unified-connector?platform=newplatform&window=90d",
      "schedule": "0 */6 * * *"
    }
  ]
}
```

提交并部署：

```bash
git add vercel.json
git commit -m "chore: add cron for newplatform"
git push
```

### Step 6: 灰度测试

**6.1 手动触发测试**

```bash
# 生产环境测试（dry-run）
curl "https://ranking-arena.vercel.app/api/cron/unified-connector?platform=newplatform&window=90d&dryRun=true" \
  -H "Authorization: Bearer $CRON_SECRET"
```

**6.2 检查 Redis 状态**

```typescript
// 在 Vercel Logs 或本地运行
import { getAllConnectorStatuses } from '@/lib/connectors/connector-runner'

const statuses = await getAllConnectorStatuses(['newplatform'])
console.log(statuses[0])
// 期望: status === 'success', consecutiveFailures === 0
```

**6.3 检查 Pipeline 日志**

访问 Supabase Dashboard:
```sql
SELECT * FROM pipeline_logs
WHERE job_name = 'newplatform-connector'
ORDER BY started_at DESC
LIMIT 10;
```

**6.4 检查 Telegram 告警**

- 如果测试失败，应该收到告警
- 如果成功，不应该收到告警

### Step 7: 正式切换

**7.1 移除旧 cron job**

从 `vercel.json` 删除旧的 cron 配置：

```json
// 删除或注释掉
// {
//   "path": "/api/cron/import-newplatform",
//   "schedule": "0 */6 * * *"
// }
```

**7.2 启用新 cron job**

确保新 cron 已配置：

```json
{
  "path": "/api/cron/unified-connector?platform=newplatform&window=90d",
  "schedule": "0 */6 * * *"
}
```

**7.3 监控 1 周**

- 每天检查 Redis 状态
- 查看 Pipeline 日志
- 关注 Telegram 告警
- 对比数据量（新 vs 旧）

### Step 8: 清理旧脚本

**仅在确认稳定后执行！**

```bash
# 备份旧脚本
mkdir -p scripts/import/archive
mv scripts/import/import_newplatform.mjs scripts/import/archive/

# 提交
git add .
git commit -m "chore: archive old newplatform import script"
git push
```

## 迁移检查清单

每个平台迁移完成后，检查以下项：

- [ ] Connector 实现并测试通过
- [ ] 注册到 `unified-connector`
- [ ] Vercel Cron 配置
- [ ] 本地测试（dry-run）
- [ ] 生产环境测试（dry-run）
- [ ] Redis 状态正常
- [ ] Pipeline 日志正常
- [ ] Telegram 告警配置正常
- [ ] 数据量对比正常
- [ ] 监控 1 周无异常
- [ ] 移除旧 cron job
- [ ] 归档旧脚本

## 回滚计划

如果新 Connector 出现问题，按以下步骤回滚：

### 快速回滚

1. **恢复旧 cron job**:
   ```bash
   # 在 vercel.json 中恢复旧配置
   git revert <commit>
   git push
   ```

2. **禁用新 cron job**:
   ```json
   // 注释掉或删除
   // {
   //   "path": "/api/cron/unified-connector?platform=newplatform",
   //   "schedule": "0 */6 * * *"
   // }
   ```

3. **清除 Redis 状态**:
   ```typescript
   import { clearAllConnectorStatuses } from '@/lib/connectors/connector-runner'
   await clearAllConnectorStatuses(['newplatform'])
   ```

### 数据修复

如果新 Connector 写入了错误数据：

```sql
-- 删除指定时间范围的数据
DELETE FROM trader_identities
WHERE platform = 'newplatform'
  AND discovered_at >= '2026-03-11T00:00:00Z';
```

## 常见问题

### Q1: 新 Connector 返回 0 结果

**可能原因**:
- API 参数错误
- 认证失败
- Rate limit 被触发

**排查**:
1. 检查 API 文档
2. 查看 Pipeline 日志的 `error_message`
3. 手动调用 API 测试

### Q2: 连续失败告警

**可能原因**:
- API 不稳定
- Timeout 设置过短
- 网络问题

**解决**:
1. 增加 timeout: `timeoutMs: 120000` (2分钟)
2. 增加重试次数: `maxRetries: 5`
3. 检查 API 状态页

### Q3: 数据量不一致

**可能原因**:
- 新 Connector 逻辑错误
- API 参数不同
- 时间窗口计算错误

**解决**:
1. 对比 API 响应（旧 vs 新）
2. 检查数据转换逻辑
3. 验证时间窗口计算

## 联系和支持

- **Bug 报告**: GitHub Issues
- **告警**: Telegram 群组
- **文档**: `/docs/`

## 相关文档

- [架构设计](./CONNECTOR_ARCHITECTURE.md)
- [监控和告警](./MONITORING.md)
