# 修复计划：彻底删除 bitget_futures（第7次卡死后）

## 背景
- 16:30第7次卡死（前6次：2026-03-18 13:40, 16:45, 18:45, 20:25, 20:10等）
- 已修复CONNECTOR_MAP/PLATFORM_CONNECTORS/ACTIVE_PLATFORMS（bf942b81 + 530ee718）
- 但仍有**4个遗漏的触发源**导致再次卡死

## 找到的所有触发源

### 1. batch-fetch-traders group a4
**文件**: `./app/api/cron/batch-fetch-traders/route.ts`
**行数**: ~56行
**当前**: `a4: ['bitget_futures']`
**触发频率**: 每3小时一次 (`30 */3 * * *`)
**修复**: 改为 `a4: []` 并添加注释

### 2. auto-post-insights exchanges数组
**文件**: `./app/api/cron/auto-post-insights/route.ts`
**行数**: 153行
**当前**: `const exchanges = ['binance_futures', 'hyperliquid', 'bybit', 'okx_futures', 'bitget_futures']`
**触发频率**: 每天08:00 UTC (`0 8 * * *`)
**修复**: 从数组中删除 'bitget_futures'

### 3. auto-post-insights 平台名称映射
**文件**: `./app/api/cron/auto-post-insights/route.ts`
**行数**: 268行
**当前**: `bitget_futures: 'Bitget'`
**修复**: 删除整行

### 4. lib/cron/utils.ts enrichment配置
**文件**: `./lib/cron/utils.ts`
**行数**: ~找到bitget_futures配置块
**当前**: 定义了7D/30D/90D三个脚本配置
**修复**: 删除整个bitget_futures配置块或注释掉

### 5. lib/cron/enrichment-runner.ts 平台配置
**文件**: `./lib/cron/enrichment-runner.ts`
**当前**: 完整的平台配置（fetchEquityCurve等）
**修复**: 删除bitget_futures配置块并从timeout配置中移除

## 黑名单机制
在关键函数中添加黑名单检查，防止未来误触发：

```typescript
// 在 batch-fetch-traders, batch-enrich, enrichment-runner 中添加
const DISABLED_PLATFORMS = ['bitget_futures', 'bitget_spot', 'binance_spot']

function validatePlatform(platform: string) {
  if (DISABLED_PLATFORMS.includes(platform)) {
    throw new Error(`Platform ${platform} is permanently disabled (卡死黑名单)`)
  }
}
```

## 执行步骤
1. ✅ Kill stuck job (已完成)
2. 修复batch-fetch-traders/route.ts
3. 修复auto-post-insights/route.ts
4. 修复lib/cron/utils.ts
5. 修复lib/cron/enrichment-runner.ts
6. 添加黑名单检查机制
7. git commit + push
8. 验证部署
9. 监控24小时

## 验证命令
```bash
# 搜索残留
grep -r "bitget_futures" --include="*.ts" --exclude-dir=node_modules --exclude-dir=.vercel

# 检查pipeline_logs
psql "..." -c "SELECT started_at, job_name, status FROM pipeline_logs WHERE job_name LIKE '%bitget%' ORDER BY started_at DESC LIMIT 5;"
```

## 承诺
🔥 **不允许第8次发生！**
