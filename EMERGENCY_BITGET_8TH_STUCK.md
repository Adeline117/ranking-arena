# 🚨 EMERGENCY: bitget_futures第8次卡死 - 黑名单失效分析

**事件时间：** 2026-03-19 02:30 PDT
**问题：** enrich-bitget_futures再次卡死44分钟，这是第8次发生

## 根本原因分析

### 黑名单机制本身没有问题
- commit 686ed128 (2026-03-18 16:36) 正确部署了黑名单机制
- `DISABLED_PLATFORMS`配置文件创建成功
- `validatePlatform()`函数正确实现并被调用

### 真正的问题：黑名单被后续commit覆盖

#### Commit 713c5f94 (2026-03-18 22:54)
- 标题："fix: resolve avatar 429s..."（修复avatar缓存问题）
- **无关改动：在同一commit中重新启用了bitget_futures！**
- 改动内容：
  ```diff
  - a4: [], // PERMANENTLY REMOVED
  + a4: ['bitget_futures'], // RE-ENABLED 2026-03-19
  ```

#### Commit dee74dbd (2026-03-19 00:57)
- 标题："feat: add okx_spot enrichment..."
- 添加okx_spot enrichment时，**意外启用了bitget_futures配置**
- enrichment-runner.ts中的配置被uncomment

## 时间线

| 时间 | 事件 |
|------|------|
| 16:36 | commit 686ed128 部署黑名单，删除bitget_futures |
| 22:54 | commit 713c5f94 修复avatar缓存，**同时重新启用bitget_futures** |
| 00:57 | commit dee74dbd 添加okx_spot，**同时启用enrichment配置** |
| 02:30 | enrich-bitget_futures第8次卡死（运行44分钟） |
| 09:30 | 紧急kill stuck job |

## 本次修复（2026-03-19 09:30）

### 1. Kill stuck job ✅
```sql
UPDATE pipeline_logs 
SET status='error', 
    error_message='Killed: stuck 44min (8th occurrence - BLACK LIST FAILED)', 
    ended_at=NOW() 
WHERE job_name='enrich-bitget_futures' AND status='running';
```

### 2. 彻底删除所有触发源 ✅

**batch-fetch-traders/route.ts:**
```ts
a4: [], // bitget_futures NEVER RE-ENABLE - scraper hangs repeatedly
```

**enrichment-runner.ts:**
```ts
// bitget_futures: PERMANENTLY DISABLED 2026-03-19
// VPS scraper repeatedly hangs despite timeout
// (配置已注释)
```

**PLATFORM_TIMEOUT_MS:**
```ts
// 'bitget_futures': PERMANENTLY REMOVED 2026-03-19
```

### 3. 强化黑名单 ✅

**lib/config/platforms.ts:**
```ts
export const DISABLED_PLATFORMS = ['bitget_spot', 'bitget_futures'] as const
```

### 4. 删除Vercel cron ✅

**vercel.json:**
```json
// Group a4 (bitget_futures) PERMANENTLY DISABLED 2026-03-19
// (cron entry已注释)
```

## 验证

- [x] batch-fetch-traders: a4 = []
- [x] enrichment-runner: bitget_futures配置已注释
- [x] PLATFORM_TIMEOUT_MS: bitget_futures已删除
- [x] DISABLED_PLATFORMS: 包含bitget_futures
- [x] vercel.json: a4 cron已注释
- [x] validatePlatform()在enrichment-runner中被调用

## 经验教训

### 1. 不要在feature commit中混入无关改动
- commit 713c5f94的主题是"修复avatar缓存"
- 但同时修改了batch-fetch-traders，重新启用bitget_futures
- **这是非常危险的做法！**

### 2. Code review需要更严格
- 即使是小改动，也要检查diff中的所有文件
- 注意"顺便修复"的改动

### 3. 黑名单机制需要测试覆盖
- 应该有测试验证DISABLED_PLATFORMS真的会阻止执行
- 目前只有运行时检查，没有CI/CD层面的验证

## 防止第9次发生

### 保护机制
1. ✅ DISABLED_PLATFORMS黑名单（已强化）
2. ✅ validatePlatform()运行时检查
3. ✅ 所有配置文件中的注释和警告
4. ✅ Vercel cron已删除
5. ✅ 本文档作为历史记录

### 监控
- Pipeline logs已记录所有8次卡死
- 如果第9次发生，说明代码中还有隐藏的触发源

## Git History

相关commits:
- 686ed128 - 第7次修复，添加黑名单
- 713c5f94 - **意外重新启用** (avatar缓存修复)
- dee74dbd - **意外启用配置** (okx_spot添加)
- (current) - 第8次修复，彻底删除

---

**不允许第9次发生！**
