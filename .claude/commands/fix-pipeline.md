# Fix Data Pipeline

Diagnose and fix data pipeline issues for Arena trader data.

## 自动诊断

运行健康检查脚本识别问题：

```bash
# 完整健康检查
node scripts/pipeline-health-check.mjs

# 快速检查（仅数据新鲜度）
node scripts/pipeline-health-check.mjs --quick

# 生成修复脚本
node scripts/pipeline-health-check.mjs --fix
```

## 修复流程

### 1. 识别问题类型

| 症状 | 可能原因 | 修复方向 |
|------|---------|---------|
| 数据 >24h 未更新 | Cron 未运行/失败 | 检查 Vercel cron 日志 |
| HTTP 451/403 错误 | 地理封锁 | 添加代理回退 |
| 数据为空但无报错 | API 变更 | 检查 API 响应格式 |
| 部分字段 NULL | Enrichment 失败 | 检查 enrichment 日志 |

### 2. 按平台修复

**Binance (binance_futures/binance_spot):**
```bash
# 地理封锁，需要代理
# 检查 CLOUDFLARE_PROXY_URL 环境变量
# 检查 lib/cron/fetchers/binance-futures.ts 中的 fetchWithProxyFallback
```

**Bybit:**
```bash
# WAF 拦截，需要代理
# 部分 API 需要特定 headers
```

**OKX:**
```bash
# 通常稳定，检查 API 格式变化
curl 'https://www.okx.com/priapi/v5/ecotrade/public/copy-trade/total-lead-traders-new?leadPlatform=1&size=10'
```

**Bitget:**
```bash
# 检查 API v2 和 v1 兼容性
# 可能需要 BITGET_PROXY_URL
```

### 3. 标准修复步骤

```bash
# 1. 检查 Vercel 日志
vercel logs --filter cron --project ranking-arena

# 2. 手动触发 cron
curl "https://www.arenafi.org/api/cron/fetch-traders/[platform]" \
  -H "Authorization: Bearer $CRON_SECRET"

# 3. 检查数据库
node scripts/check-data-distribution.mjs

# 4. 如果需要回填
node scripts/backfill-24h.mjs --platform [platform]
```

### 4. 验证修复

```bash
# 等待下一个 cron 周期后
node scripts/pipeline-health-check.mjs --quick

# 检查前端是否正常显示
open https://www.arenafi.org/rankings
```

## 常见错误处理模板

如果 fetcher 缺少标准错误处理，参考技能：
`/.claude/skills/arena-fetcher-error-handling.md`

## Key Files
- `vercel.json` - Cron schedules
- `app/api/cron/batch-fetch-traders/route.ts` - 批量抓取入口
- `lib/cron/fetchers/` - 各平台 fetcher 实现
- `lib/cron/fetchers/enrichment.ts` - Enrichment 逻辑
- `scripts/pipeline-health-check.mjs` - 健康检查脚本

## 紧急联系

如果问题持续无法解决：
1. 检查 Sentry 告警
2. 查看 Supabase Dashboard 数据库连接状态
3. 确认 Vercel 部署状态
