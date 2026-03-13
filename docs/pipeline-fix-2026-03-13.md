# Pipeline Health 修复报告 (2026-03-13)

## 目标
- **当前健康度:** 88% (117/133)
- **失败任务:** 14个
- **目标:** 健康度 >90%，失败 <10个

## 诊断结果

### 问题1: NO_ENRICHMENT_PLATFORMS处理不当

**影响平台:** binance_web3, bingx, bitfinex, bitunix, okx_web3, web3_bot, bybit, bybit_spot, coinex, xt, bitmart, btcc, paradex, okx_spot

**问题描述:**
- 这些平台在 `NO_ENRICHMENT_PLATFORMS` 中，不支持enrichment
- `runEnrichment()` 有early exit逻辑，会返回 `ok: true`
- 但单独调用 `/api/cron/enrich?platform=xxx` 时，route会先检查平台是否在 `ENRICHMENT_PLATFORM_CONFIGS` 中
- 由于这些平台不在 `ENRICHMENT_PLATFORM_CONFIGS` 中，route直接返回400错误，导致任务失败

**修复方案:**
1. 导出 `NO_ENRICHMENT_PLATFORMS` (lib/cron/enrichment-runner.ts)
2. 修改 enrich route 检查逻辑 (app/api/cron/enrich/route.ts)
   - 允许 `NO_ENRICHMENT_PLATFORMS` 中的平台通过验证
   - 让 `runEnrichment()` 处理early exit
3. 这些平台的enrichment调用现在会返回 `ok: true` 而不是400错误

**预期改善:** 修复最多14个失败任务（如果这些平台都有单独的cron调用）

## 实施的修复

### 修复1: 导出NO_ENRICHMENT_PLATFORMS
**文件:** `lib/cron/enrichment-runner.ts`
```typescript
// Before:
const NO_ENRICHMENT_PLATFORMS = new Set([...])

// After:
export const NO_ENRICHMENT_PLATFORMS = new Set([...])
```

### 修复2: 修改enrich route验证逻辑
**文件:** `app/api/cron/enrich/route.ts`
```typescript
// Before:
if (platformParam && !(platformParam in ENRICHMENT_PLATFORM_CONFIGS)) {
  return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
}

// After:
// Allow NO_ENRICHMENT_PLATFORMS - runEnrichment will handle them gracefully
if (platformParam && !(platformParam in ENRICHMENT_PLATFORM_CONFIGS) && !NO_ENRICHMENT_PLATFORMS.has(platformParam)) {
  return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
}
```

## Commit信息

**Commit:** f843de42
```
fix: export NO_ENRICHMENT_PLATFORMS and handle them in enrich route

Problem: 单独调用 /api/cron/enrich?platform=binance_web3 等不支持enrichment的平台时返回400错误

Solution:
1. 导出 NO_ENRICHMENT_PLATFORMS 以便其他模块使用
2. 修改 enrich route 以正确处理 NO_ENRICHMENT_PLATFORMS 中的平台
   - 不再返回400错误
   - 而是调用 runEnrichment，后者会early exit并返回成功

Impact:
- binance_web3, bingx, bitfinex, bitunix 等平台的单独enrichment调用将返回成功而不是失败
- 预期修复4个失败任务，改善健康度 88% → 91%
```

## 验证方案

### 方法1: 使用验证脚本
```bash
cd /Users/adelinewen/ranking-arena
export CRON_SECRET="your-secret"
export VERCEL_URL="https://ranking-arena.vercel.app"
bash scripts/verify-enrichment-fix.sh
```

脚本会测试所有14个NO_ENRICHMENT_PLATFORMS平台，验证它们是否返回200 OK + ok: true

### 方法2: 手动验证
```bash
# 测试单个平台
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://ranking-arena.vercel.app/api/cron/enrich?platform=binance_web3&period=90D&limit=10"

# 预期响应:
# {"ok":true,"duration":0,"period":"90D","summary":{"total":0,"enriched":0,"failed":0},"results":{}}
```

### 方法3: 等待下一次cron运行
- 部署后等待相关cron任务自动运行
- 检查pipeline health dashboard
- 确认失败任务数量减少

## 其他潜在问题

由于无法连接到生产Redis获取完整的失败任务列表，以下是基于代码分析的其他可能失败原因：

### 1. batch-fetch-traders-d2
- **组成:** 只有dydx一个平台（bybit_spot已移除）
- **可能问题:** dydx fetcher超时或API问题
- **验证:** 查看最近的dydx fetch日志
- **状态:** 代码最近有优化（避免Cloudflare 120s超时），应该已修复

### 2. batch-enrich相关任务
- **问题:** 可能因超时或平台限速失败
- **最近修复:** 已有多轮超时优化（减少batch size，增加超时时间）
- **状态:** 应该已改善

### 3. 其他未知失败
- 需要访问生产Redis或Vercel logs获取完整列表
- 建议定期运行 `node infra/bullmq/health-check.js`（在有Redis连接的环境）

## 预期改善

**保守估计:**
- 修复4-8个NO_ENRICHMENT_PLATFORMS相关任务
- 健康度从88%提升到 **90-92%**

**最佳情况:**
- 所有14个失败任务都是NO_ENRICHMENT_PLATFORMS相关
- 健康度提升到 **100%**

## 后续行动

1. ✅ 代码已推送并通过CI检查
2. ⏳ 等待Vercel自动部署
3. ⏳ 运行验证脚本确认修复
4. ⏳ 监控24小时，观察健康度变化
5. ⏳ 如果仍有失败任务，需要访问生产Redis获取详细列表

## 时间记录

- **开始时间:** 2026-03-13 11:08 PDT
- **完成时间:** 2026-03-13 11:23 PDT
- **耗时:** 15分钟
- **超时限制:** 20分钟 ✅ 未超时

## 相关文件

- `lib/cron/enrichment-runner.ts` - NO_ENRICHMENT_PLATFORMS定义和early exit逻辑
- `app/api/cron/enrich/route.ts` - 单独enrichment任务endpoint
- `app/api/cron/batch-enrich/route.ts` - 批量enrichment调度
- `scripts/verify-enrichment-fix.sh` - 验证脚本
- `vercel.json` - Cron配置

## 联系信息

如需进一步调试或获取实时健康度数据：
1. 访问Vercel dashboard查看cron logs
2. 连接生产Redis运行 `node infra/bullmq/health-check.js`
3. 查看 `/api/health/pipeline` endpoint
