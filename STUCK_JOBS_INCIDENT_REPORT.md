# Stuck Jobs Incident Report - 2026-03-21

## 事件概要
- **发现时间**: 17:00 PST (heartbeat检查)
- **Stuck任务数**: 324个
- **影响时间**: 14:30 - 17:00 PST（2.5小时）
- **已清理**: 全部324个任务已kill

## 根因分析

### 1. Cleanup Cron停止运行
- **最后成功运行**: 22:07 UTC (15:07 PST)
- **预期运行时间**: 23:07 UTC，但未运行
- **停止原因**: 20:07运行卡住1小时后超时，可能触发Vercel cron保护机制

### 2. Cleanup逻辑缺陷
cleanup-stuck-logs查询缺少关键条件：
```typescript
// 当前查询（有问题）
.eq('status', 'running')
.lt('started_at', thirtyMinutesAgo)

// 应该是
.eq('status', 'running')
.lt('started_at', thirtyMinutesAgo)
.is('ended_at', null)  // ← 缺少这个！
```

**后果**: 如果数据存在status='running'但ended_at有值的不一致记录，会被错误处理。

### 3. 数据累积时间线
| 时间 | 事件 |
|------|------|
| 14:30 | 最后正常状态（0个stuck）|
| 14:30-17:00 | Enrichment任务开始卡住并累积 |
| 15:07 (22:07 UTC) | 最后一次cleanup运行（清理0个）|
| 16:07 | **Cleanup未运行** |
| 17:00 | Heartbeat发现317个stuck |
| 17:06 (00:06 UTC) | 手动清理128个>2h任务 |
| 17:08 (00:08 UTC) | 清理剩余200个任务 |

## 直接原因
- 大量enrichment任务卡住（主要是enrich-okx, enrich-bingx）
- Cleanup cron在16:07未运行，导致累积

## 根本原因
1. **Enrichment任务容易超时** - 为什么？
   - API响应慢？
   - 数据库连接池耗尽？
   - Vercel function超时？
2. **Cleanup机制不可靠**
   - 会自己卡住（20:07事件）
   - 卡住后cron停止
   - 缺少`.is('ended_at', null)`过滤

## 已执行修复

### 1. 清理stuck任务
```bash
# 清理所有stuck任务
node scripts/kill-all-stuck.mjs
# 结果: 324个全部清理
```

### 2. 创建诊断工具
- `scripts/diagnose-stuck-final.mjs` - 诊断stuck任务分布
- `scripts/kill-stuck-jobs.mjs` - kill >2h的任务
- `scripts/kill-all-stuck.mjs` - kill >30min的任务
- `scripts/check-cleanup-cron-status.mjs` - 检查cleanup运行状态

## 待修复（必须做）

### Priority 1: 修复cleanup逻辑
```typescript
// app/api/cron/cleanup-stuck-logs/route.ts
const { data: stuckLogs, error: fetchError } = await supabase
  .from('pipeline_logs')
  .select('id, job_name, started_at')
  .eq('status', 'running')
  .lt('started_at', thirtyMinutesAgo)
  .is('ended_at', null)  // ← 添加这个
  .order('started_at', { ascending: false })
```

### Priority 2: 防止cleanup自己卡住
- 添加query超时限制
- 分批处理（最多100个/次）
- 如果stuck数量>1000，只kill最老的500个

### Priority 3: 调查enrichment卡住原因
```bash
# 查看enrichment-okx的日志
grep "enrich-okx" /var/log/vercel/*.log

# 检查数据库连接池
SELECT count(*) FROM pg_stat_activity;

# 查看API调用耗时
# (需要添加更多监控)
```

### Priority 4: 添加监控告警
- Stuck数量>50 → Telegram告警（已有，但cleanup未触发）
- Cleanup未运行 → 告警
- Cleanup自己超时 → 告警

## 预防措施（长期）

### 1. Enrichment任务优化
- 添加超时限制（max 10分钟）
- 实现circuit breaker
- 失败后exponential backoff

### 2. 数据库连接池监控
- 定期检查活跃连接数
- 连接池耗尽时告警

### 3. 双重保险
- Cleanup cron: 每小时7分
- Backup cleanup: 每2小时运行更激进的清理（kill >1h的）

### 4. Heartbeat集成
- 在HEARTBEAT.md添加检查stuck任务
- 数量>100时自动spawn修复子代理

## 经验教训

1. **自动清理机制必须可靠**
   - Cleanup不能依赖单一cron
   - 需要监控cleanup本身的健康度
   
2. **数据一致性很重要**
   - 查询时必须同时检查status和ended_at
   - 避免数据不一致导致的误判

3. **监控要全面**
   - 不仅监控业务任务，还要监控清理任务
   - Cleanup失败/未运行也要告警

4. **诊断工具必不可少**
   - 事故发生时需要快速诊断脚本
   - 今天花了10分钟创建工具，才能快速定位问题

## 下一步行动

- [ ] 修复cleanup逻辑（添加ended_at过滤）
- [ ] 部署并验证cleanup正常运行
- [ ] 调查enrich-okx为什么卡住
- [ ] 添加backup cleanup cron
- [ ] 更新HEARTBEAT.md添加stuck检查
- [ ] 文档化这次事故的修复过程
