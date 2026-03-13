# Arena Pipeline Fix - 2026-03-13

## 问题总结

### 失败任务统计
- **18个任务失败**（共32个任务）
- **batch-enrich-7D/30D/90D**: 全部超时（600秒限制）
- **batch-fetch-traders-a2/d2**: 平台失败

## 根本原因分析

### 1. batch-enrich超时（所有7D/30D/90D任务）
**现象**：所有batch-enrich任务在580秒时触发safety timeout

**根本原因**：
- dydx平台enrichment固定超时360秒
- dydx在第一批次（HIGH_PRIORITY）中运行
- 第一批次：binance_futures(~50s) + okx_futures(~85s) + bitget_futures(~75s) + hyperliquid(~190s) + **dydx(360s timeout)** = 760秒
- dydx超时后触发总体580秒safety timeout，导致后续平台（jupiter_perps, binance_spot, htx_futures等）根本没机会运行

**影响**：
- 每次运行只完成4-5个平台（总共13个平台）
- 8-9个平台被跳过（"Skipped: period budget exhausted"）

### 2. batch-fetch-traders-a2失败
**现象**：1/3 platforms failed

**错误信息**：
```
platform: bybit
error: 7D: All strategies failed (VPS scraper, direct API, CF proxy, VPS proxy)
       30D: All strategies failed (VPS scraper, direct API, CF proxy, VPS proxy)
       90D: All strategies failed (VPS scraper, direct API, CF proxy, VPS proxy)
totalSaved: 0
```

**根本原因**：bybit API endpoints (api2.bybit.com) 全球404

### 3. batch-fetch-traders-d2失败
**现象**：1/2 platforms failed

**错误信息**：
```
platform: bybit_spot
error: Platform bybit_spot timed out after 420s
```

**根本原因**：bybit_spot API同样404（与bybit相同问题）

## 修复方案

### Fix 1: 移除失效的bybit平台

**文件**: `lib/cron/fetchers/index.ts`
```diff
- import { fetchBybit } from './bybit'
- import { fetchBybitSpot } from './bybit-spot'
+ // REMOVED 2026-03-13: bybit API endpoints (api2.bybit.com) return 404 globally
+ // import { fetchBybit } from './bybit'
+ // import { fetchBybitSpot } from './bybit-spot'

- bybit: fetchBybit,
- bybit_spot: fetchBybitSpot,
+ // REMOVED 2026-03-13: bybit API endpoints return 404 globally
+ // bybit: fetchBybit,
+ // bybit_spot: fetchBybitSpot,
```

**文件**: `app/api/cron/batch-fetch-traders/route.ts`
```diff
- a2: ['bybit', 'bitget_futures', 'okx_futures'],
+ a2: ['bitget_futures', 'okx_futures'], // bybit removed from array 2026-03-13

- d2: ['dydx', 'bybit_spot'],
+ d2: ['dydx'], // bybit_spot removed from array 2026-03-13
```

### Fix 2: 优化dydx enrichment位置

**文件**: `app/api/cron/batch-enrich/route.ts`

**策略**：将dydx移到批次末尾，即使超时也不影响其他平台

```diff
- const HIGH_PRIORITY = ['binance_futures', 'okx_futures', 'bitget_futures', 'hyperliquid', 'dydx', 'jupiter_perps']
+ // dydx moved to end: consistently times out at 360s, blocking other platforms
+ const HIGH_PRIORITY = ['binance_futures', 'okx_futures', 'bitget_futures', 'hyperliquid', 'jupiter_perps']

+ // Low priority - dydx (moved here due to consistent 360s timeout)
+ // Still enriched, but runs last to avoid blocking high/medium priority platforms
+ const DYDX_PRIORITY = ['dydx']

  let platforms: string[]
  if (enrichAll) {
-   platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY, ...LOWER_PRIORITY]
+   platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY, ...LOWER_PRIORITY, ...DYDX_PRIORITY]
  } else {
-   platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY]
+   platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY, ...DYDX_PRIORITY]
  }
```

### Fix 3: 降低dydx limits

**文件**: `app/api/cron/batch-enrich/route.ts`

```diff
- dydx: { limit90: 150, limit30: 120, limit7: 100 },
+ dydx: { limit90: 80, limit30: 60, limit7: 50 }, // REDUCED 2026-03-13: was timing out at 360s
```

**原因**：减少enrichment数量，提高在360秒内完成的概率

## 预期效果

### batch-fetch-traders
| 任务 | 修复前 | 修复后 |
|------|--------|--------|
| batch-fetch-traders-a2 | ❌ 1/3 failed (bybit失败) | ✅ 2/2 success |
| batch-fetch-traders-d2 | ❌ 1/2 failed (bybit_spot超时) | ✅ 1/1 success |

### batch-enrich
| 任务 | 修复前 | 修复后 |
|------|--------|--------|
| batch-enrich-90D | ❌ timeout (4/13平台完成) | ✅ success (12/13平台完成) |
| batch-enrich-30D | ❌ timeout (4/13平台完成) | ✅ success (12/13平台完成) |
| batch-enrich-7D | ❌ timeout (4/13平台完成) | ✅ success (12/13平台完成) |

**说明**：
- dydx仍可能超时，但不会阻塞其他12个平台
- 即使dydx超时，任务整体也会被标记为"部分成功"而非完全失败

### 整体成功率
- **修复前**: 14/32 tasks success (43.75%)
- **修复后预期**: ~28/32 tasks success (87.5%)
- **改进**: +14 tasks (+43.75%)

## 部署信息

- **Commit**: 9e0b6389
- **部署时间**: 2026-03-13 02:24 PDT (09:24 UTC)
- **Git push**: ✅ 成功
- **Lint check**: ✅ 通过
- **Type check**: ✅ 通过

## 验证计划

### 自动验证（Cron调度）
下次运行时间（UTC）：
- **batch-fetch-traders-a2**: 09:50 (26分钟后)
- **batch-enrich-90D**: 10:10 (46分钟后)
- **batch-enrich-30D**: 10:25 (1小时1分钟后)
- **batch-enrich-7D**: 10:40 (1小时16分钟后)
- **batch-fetch-traders-d2**: 12:28 (3小时4分钟后)

### 手动验证脚本

运行以下命令检查修复后的首次运行结果：

```bash
cd /Users/adelinewen/ranking-arena
# Or run: ./scripts/verify-pipeline-fix.sh
npx tsx -e "
import { createClient } from '@supabase/supabase-js';

(async () => {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const deployTime = new Date('2026-03-13T09:24:00Z');

  const { data, error } = await supabase
    .from('pipeline_logs')
    .select('*')
    .or('job_name.eq.batch-fetch-traders-a2,job_name.eq.batch-fetch-traders-d2,job_name.ilike.batch-enrich-%')
    .gte('started_at', deployTime.toISOString())
    .order('started_at', { ascending: false })
    .limit(10);

  if (!data || data.length === 0) {
    console.log('⏳ 等待首次运行...');
    return;
  }

  console.log('✅ 修复后运行结果:\n');
  data.forEach(log => {
    const icon = log.status === 'success' ? '✅' : '❌';
    console.log(\`\${icon} \${log.job_name}\`);
    console.log(\`   Status: \${log.status}\`);
    console.log(\`   Duration: \${Math.round(log.duration_ms / 1000)}s\`);
    if (log.error_message) {
      console.log(\`   Error: \${log.error_message}\`);
    }
    if (log.metadata?.results) {
      const results = log.metadata.results;
      const ok = results.filter((r: any) => r.status === 'success').length;
      console.log(\`   Platforms: \${ok}/\${results.length} success\`);
    }
    console.log('');
  });
})();
"
```

## 修复文件清单

1. `app/api/cron/batch-enrich/route.ts`
   - 移除dydx from HIGH_PRIORITY
   - 新增DYDX_PRIORITY数组
   - 调整platforms数组构建逻辑
   - 降低dydx limits (90D: 150→80, 30D: 120→60, 7D: 100→50)

2. `app/api/cron/batch-fetch-traders/route.ts`
   - 从a2组移除bybit
   - 从d2组移除bybit_spot

3. `lib/cron/fetchers/index.ts`
   - 注释掉bybit/bybit_spot imports
   - 注释掉INLINE_FETCHERS中的bybit/bybit_spot注册

## 遗留问题

### dydx仍可能超时
**现状**：dydx enrichment始终在360秒时超时

**可能原因**：
- 链上数据查询慢（需要查询多个区块）
- API rate limiting
- 网络延迟

**后续优化方向**：
1. 分析dydx enrichment代码，找到性能瓶颈
2. 考虑增量更新而非全量enrichment
3. 考虑将dydx移到独立的cron任务（单独的600秒budget）
4. 使用更快的数据源（如缓存的subgraph数据）

### 监控建议
- 观察修复后dydx的成功率
- 如果dydx持续超时，考虑进一步优化或拆分任务
- 监控其他onchain平台（hyperliquid, gmx, jupiter_perps）的enrichment时间

---

**修复完成时间**: 2026-03-13 02:24 PDT
**预期验证时间**: 2026-03-13 02:50 PDT (batch-fetch-traders-a2首次运行)
**负责人**: 小昭 (Subagent)
