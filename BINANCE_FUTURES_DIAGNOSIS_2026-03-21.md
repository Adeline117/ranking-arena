# Binance Futures 反复卡死问题 - 深度诊断报告
**日期**: 2026-03-21 01:00 PDT  
**问题**: binance_futures enrichment 反复卡死 46-77 分钟

---

## 📊 卡死历史（过去24小时）

| ID    | 开始时间  | 持续时间 | Period | Limit | 状态    |
|-------|---------|----------|--------|-------|---------|
| 17956 | 08:45   | 46分钟   | 90D    | 200   | timeout |
| 18317 | 14:45   | 45分钟   | 90D    | 200   | timeout |
| 18529 | 16:46   | 45分钟   | 90D    | 200   | timeout |
| 18632 | 18:43   | 83分钟   | 30D    | 200   | timeout |
| 18785 | 20:43   | 48分钟   | 30D    | 200   | timeout |
| 19476 | 06:43   | 79分钟   | 30D    | 200   | timeout ← 诊断时kill |

**共同点**：
- ✅ **全部是30D或90D period**（7D任务全部成功，1-2分钟完成）
- ✅ 卡死时间：44-83分钟
- ✅ 正常任务完成时间：1-2分钟

---

## 🔍 根本原因分析

### 1. VPS Proxy 本身很快 ✅

测试结果（直接调用VPS proxy）：
```
7D:  平均 395ms, 最大 575ms
30D: 平均 295ms, 最大 334ms
90D: 平均 324ms, 最大 409ms
```

**结论**: VPS proxy响应速度正常，远低于6秒timeout。

### 2. Timeout层级问题 ❌

当前timeout配置：
- **API层**: 6秒 (`timeoutMs: 6000` in fetchWithProxyFallback)
- **Trader层**: 20秒 (`PER_TRADER_TIMEOUT_MS['binance_futures']`)
- **Platform层**: 120秒 (`PLATFORM_TIMEOUT_MS['binance_futures']`)

**问题所在**：
```typescript
// enrichment-types.ts (VPS proxy调用)
signal: AbortSignal.timeout(opts.timeoutMs || 10_000)

// enrichment-runner.ts (外层timeout)
const traderController = new AbortController()
setTimeout(() => traderController.abort(), traderTimeoutMs)
```

**致命缺陷**：
1. ✅ VPS proxy使用`AbortSignal.timeout()` - 这是**静态timeout**，创建后无法取消
2. ❌ **外层的`traderController.signal`没有传递给VPS proxy请求**
3. ❌ 如果VPS proxy服务器端卡住（TCP连接建立但无响应），`AbortSignal.timeout()`可能失效
4. ❌ Node.js的fetch实现中，AbortSignal.timeout可能在某些边缘情况下不生效（特别是POST请求到VPS proxy）

### 3. VPS Proxy服务器端问题 ⚠️

可能的VPS proxy服务器端问题：
- 没有设置request timeout
- 对binance API的请求卡在TCP层（连接建立但无响应）
- 没有正确处理abort信号

---

## 🎯 永久解决方案

### 方案1: 修复Timeout传递（推荐）✨

**核心改动**：将外层AbortSignal传递给所有fetch请求

```typescript
// enrichment-types.ts
export async function fetchWithProxyFallback<T>(
  url: string,
  opts: { 
    method?: string; 
    headers?: Record<string, string>; 
    body?: unknown; 
    timeoutMs?: number;
    signal?: AbortSignal;  // ← 新增：接受外层signal
  }
): Promise<T> {
  // 组合timeout: 使用外层signal + 内部timeout
  const combinedSignal = opts.signal 
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs || 10_000)])
    : AbortSignal.timeout(opts.timeoutMs || 10_000)
  
  // VPS proxy请求
  const response = await fetch(vpsUrl, {
    method: 'POST',
    headers: { ... },
    body: JSON.stringify({ ... }),
    signal: combinedSignal,  // ← 使用组合signal
  })
}
```

```typescript
// enrichment-runner.ts
// 传递traderController.signal到所有API调用
fetchPromises.equityCurve = withRetry(
  () => config.fetchEquityCurve!(traderId, days, traderController.signal),
  `${platformKey}:${traderId} equity curve`
)
```

**优点**：
- ✅ 真正的双层timeout保护
- ✅ 外层abort能立即终止所有进行中的请求
- ✅ 保留现有的重试逻辑

### 方案2: 缩短Timeout + 快速失败 ⚡

如果方案1实现复杂，临时方案：
```typescript
// enrichment-binance.ts
const ULTRA_SHORT_TIMEOUT = {
  '7D': 3000,   // 3秒
  '30D': 5000,  // 5秒
  '90D': 8000,  // 8秒
}

export async function fetchBinanceEquityCurve(
  traderId: string,
  timeRange: string = '90D'
): Promise<EquityCurvePoint[]> {
  try {
    const data = await fetchWithProxyFallback<Record<string, unknown>>(
      `${BINANCE_PUBLIC}/lead-portfolio/chart-data?...`,
      { method: 'GET', timeoutMs: ULTRA_SHORT_TIMEOUT[timeRange] || 8000 }
    )
    // ...
  } catch (err) {
    logger.warn(`[enrichment] Binance equity curve failed for ${traderId}: ${err}`)
    return []  // 快速失败，返回空数组，继续下一个trader
  }
}
```

**配置调整**：
```typescript
// enrichment-runner.ts
const RETRY_CONFIG = {
  maxAttempts: 1,  // 保持1次重试（已有）
  baseDelayMs: 0,   // 0延迟
  maxDelayMs: 0,
}
```

**优点**：
- ✅ 实现简单，立即部署
- ✅ 单个trader失败不影响整体
- ❌ 可能导致部分数据丢失（但好过整个pipeline卡死）

### 方案3: VPS Proxy服务器端修复 🔧

如果有VPS proxy源码访问权限：
```javascript
// VPS proxy服务器端（假设是Express）
app.post('/proxy', async (req, res) => {
  const { url, method, headers, body } = req.body
  
  // 服务器端也设置timeout
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)  // 10秒硬timeout
  
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal
    })
    clearTimeout(timeout)
    // ...
  } catch (err) {
    clearTimeout(timeout)
    res.status(504).json({ error: 'Gateway timeout' })
  }
})
```

---

## 📋 推荐实施步骤

### 立即实施（今天）：
1. ✅ Kill当前卡住的任务（id 19476）- **已完成**
2. ✅ 实施**方案2**（缩短timeout + 快速失败）
   - 修改binance enrichment的timeout配置
   - 禁用retry（已有）
   - Git commit + push

### 短期实施（本周）：
3. 实施**方案1**（修复timeout传递）
   - 修改fetchWithProxyFallback接受外层signal
   - 修改所有enrichment调用传递signal
   - 全面测试
   - Git commit + push

### 长期改进（可选）：
4. 实施**方案3**（VPS proxy服务器端修复）
   - 如果有源码访问权限
   - 添加服务器端timeout
   - 改进错误处理

---

## 🧪 验证方案

实施修复后，验证：
```sql
-- 监控binance_futures任务
SELECT 
  id, status, 
  started_at, ended_at,
  duration_ms / 60000 as duration_minutes,
  metadata->'period' as period
FROM pipeline_logs
WHERE job_name = 'enrich-binance_futures'
  AND started_at >= NOW() - INTERVAL '6 hours'
ORDER BY started_at DESC;
```

**成功标准**：
- ✅ 所有30D/90D任务在3分钟内完成
- ✅ 无任务超过5分钟
- ✅ 失败率 < 5%

---

## 📝 附加发现

1. **7D vs 30D/90D响应时间差异不大**（测试显示30D甚至比7D快）
2. **VPS proxy本身不是瓶颈**（平均<400ms）
3. **问题在于timeout机制失效**，导致单个请求卡住→整个batch卡住
4. **Vercel maxDuration=60秒未生效**（可能是cron job绕过了限制）

---

## 🔗 相关文件

- `lib/cron/fetchers/enrichment-types.ts` - fetchWithProxyFallback实现
- `lib/cron/fetchers/enrichment-binance.ts` - Binance enrichment实现
- `lib/cron/enrichment-runner.ts` - 核心enrichment逻辑
- `app/api/cron/enrich/route.ts` - API route入口

---

**报告生成时间**: 2026-03-21 01:03 PDT  
**诊断代理**: agent:main:subagent:811d3168-a7b6-4c43-b94f-64818bec43c4
