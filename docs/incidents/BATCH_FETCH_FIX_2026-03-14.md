# Batch-Fetch-Traders Pipeline Fix 2026-03-14

## 问题诊断

**症状：** Arena Pipeline 健康度 91.4% (127/139 jobs healthy)

**失败任务：** 11个平台失败，涉及5个batch-fetch-traders组
- batch-fetch-traders-a: 1/2 platforms failed  
- batch-fetch-traders-a2: 3/3 platforms failed (全挂)
- batch-fetch-traders-b: 3/3 platforms failed (全挂)
- batch-fetch-traders-c: 3/3 platforms failed (全挂)
- batch-fetch-traders-d1: 1/2 platforms failed

## 根本原因

**配置不同步：**
1. `app/api/cron/batch-fetch-traders/route.ts` 中已经将失败平台移除或组设为空数组
2. `vercel.json` 中的cron配置仍在调用这些空组，导致监控系统记录为失败

## 失败平台详情

### Group A2 (已禁用)
- **bybit:** api2.bybit.com returns 403 Access Denied
- **bitget_futures:** Cloudflare challenge blocking direct API access
- **okx_futures:** API endpoint returning 404

### Group B (已禁用)
- **hyperliquid:** 422 error
- **gmx:** 404 error  
- **jupiter_perps:** 0 traders normalization failed

### Group C (已禁用)
- **okx_web3:** 400 error
- **aevo:** 0 traders returned
- **xt:** 0 traders returned

### Group D2 (已禁用)
- **dydx:** Client error 404

### Group A (部分移除)
- **binance_futures:** Client error 404 (已移除，保留binance_spot)

### Group D1 (部分移除)
- **htx_futures:** Client error 405 (已移除，保留gains)

## 修复方案

### 已完成 (2026-03-14)

✅ **从 vercel.json 移除空组的cron任务**
- 移除 `batch-fetch-traders?group=a2` (每3小时)
- 移除 `batch-fetch-traders?group=b` (每4小时)
- 移除 `batch-fetch-traders?group=c` (每4小时)
- 移除 `batch-fetch-traders?group=d2` (每6小时)

✅ **Git commit + push**
```bash
git commit -m "fix: remove empty batch-fetch-traders groups from Vercel cron"
git push origin main
```

## 当前活跃组配置

保留的8个batch-fetch-traders组：

| Group | Platforms | Schedule | Count |
|-------|-----------|----------|-------|
| a | binance_spot | 每3小时 | 1 |
| d1 | gains | 每6小时 | 1 |
| e | bitfinex | 每6小时 | 1 |
| f | mexc, bingx | 每6小时 | 2 |
| h | gateio, btcc | 每6小时 | 2 |
| g1 | drift, bitunix | 4次/天 | 2 |
| g2 | web3_bot, toobit, bitget_spot | 4次/天 | 3 |
| i | etoro | 4次/天 | 1 |

**总计：** 8个组，13个活跃平台

## 预期结果

**修复前：** 127/139 jobs = 91.4% healthy

**修复后（预期）：** 
- 移除4个空组cron = 减少11个失败任务
- 新的总任务数：139 - 4 = 135 jobs
- 健康度：127/135 = **94.1%**

如果a和d1组中已移除失败平台后完全正常，则：
- 健康度：135/135 = **100%**

## 验证步骤

等待Vercel部署完成（~2分钟）后：

1. ✅ 检查Vercel部署状态
2. ⏳ 等待下一个cron周期（最长6小时）
3. ⏳ 运行健康检查：`node scripts/openclaw/pipeline-health-monitor.mjs`
4. ⏳ 确认健康度 >95%

## 长期改进建议

1. **自动同步检查：** 添加CI检查确保vercel.json的cron与route.ts中的GROUPS配置同步
2. **优雅处理空组：** route.ts可以对空组返回204 No Content而不是200 OK
3. **VPS代理恢复：** 为a2/b/c组的平台配置VPS scraper代理后重新启用
4. **监控告警：** 配置Telegram告警，当健康度<95%时自动通知

## 相关文件

- `app/api/cron/batch-fetch-traders/route.ts` - 平台组定义
- `vercel.json` - Vercel cron配置
- `scripts/openclaw/pipeline-health-monitor.mjs` - 健康检查脚本

## 修复记录

- **发现时间：** 2026-03-14 18:04 PDT
- **修复时间：** 2026-03-14 18:10 PDT
- **修复人：** 小昭 (subagent)
- **Git commit：** ee6a3ec5
