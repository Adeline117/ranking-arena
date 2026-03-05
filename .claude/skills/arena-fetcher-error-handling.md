# Arena Fetcher 错误处理标准模板

当修复或创建 Arena 的 fetcher 时，使用以下标准错误处理模板。

## 必须包含的模式

### 1. 外层 try-catch 包裹

```typescript
export async function fetchPlatform(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const startTime = Date.now()
  const periodResults: Record<string, { total: number; saved: number; error?: string }> = {}

  for (const period of periods) {
    try {
      const result = await fetchPeriod(supabase, period)
      periodResults[period] = result
    } catch (err) {
      // 1. 记录到 Sentry
      captureException(err, {
        tags: { platform: SOURCE, period },
        extra: { duration: Date.now() - startTime }
      })

      // 2. 本地日志
      logger.error(`[${SOURCE}] Period ${period} failed:`, err)

      // 3. 记录失败但继续其他 period
      periodResults[period] = {
        total: 0,
        saved: 0,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  return {
    source: SOURCE,
    periods: periodResults,
    duration: Date.now() - startTime
  }
}
```

### 2. API 调用错误处理

```typescript
async function fetchPage(pageNo: number): Promise<ApiResponse | null> {
  const MAX_RETRIES = 3
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await fetchJson<ApiResponse>(url, {
        method: 'POST',
        headers: HEADERS,
        body: { pageNumber: pageNo, pageSize: PAGE_SIZE },
        timeoutMs: 15000,
      })

      // 检查 API 级别错误
      if (data.code !== '0' && data.code !== '000000') {
        throw new Error(`API error: ${data.code} - ${data.msg || data.message}`)
      }

      return data
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      // 判断是否可重试
      const isRetryable = lastError.message.includes('timeout') ||
                          lastError.message.includes('429') ||
                          lastError.message.includes('503')

      if (isRetryable && attempt < MAX_RETRIES) {
        const delayMs = Math.pow(2, attempt) * 1000 // 指数退避
        logger.warn(`[${SOURCE}] Retry ${attempt}/${MAX_RETRIES} in ${delayMs}ms`)
        await sleep(delayMs)
        continue
      }

      break
    }
  }

  // 所有重试失败
  logger.error(`[${SOURCE}] All retries failed:`, lastError)
  return null
}
```

### 3. 代理回退（地理封锁）

```typescript
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

async function fetchWithProxyFallback<T>(url: string, opts: FetchOptions): Promise<T> {
  // 先尝试直连
  try {
    return await fetchJson<T>(url, opts)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''

    // 如果是地理封锁或 WAF 拦截，使用代理
    if (msg.includes('451') || msg.includes('403') || msg.includes('Access Denied')) {
      logger.warn(`[${SOURCE}] Geo-blocked, trying proxy: ${url.slice(0, 50)}...`)

      const proxyTarget = `${PROXY_URL}?url=${encodeURIComponent(url)}`
      return await fetchJson<T>(proxyTarget, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: opts.body,
        timeoutMs: opts.timeoutMs,
      })
    }

    throw err
  }
}
```

### 4. 数据库操作错误处理

```typescript
async function saveTraders(supabase: SupabaseClient, traders: TraderData[]): Promise<{ saved: number; error?: string }> {
  if (traders.length === 0) {
    return { saved: 0 }
  }

  try {
    const { error } = await supabase
      .from('trader_snapshots')
      .upsert(traders, {
        onConflict: 'source,source_trader_id,season_id',
        ignoreDuplicates: false
      })

    if (error) {
      // 记录但不抛出，让调用方决定如何处理
      logger.error(`[${SOURCE}] DB upsert failed:`, error)
      return { saved: 0, error: error.message }
    }

    return { saved: traders.length }
  } catch (err) {
    captureException(err, { tags: { platform: SOURCE, operation: 'upsert' } })
    return { saved: 0, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}
```

## 必须导入的依赖

```typescript
import { logger } from '@/lib/logger'
import { captureException, captureMessage } from '@/lib/utils/logger'
```

## 检查清单

修改 fetcher 后，确保：

- [ ] 每个 async 函数都有 try-catch
- [ ] 错误写入 Sentry（captureException）
- [ ] 错误写入本地日志（logger.error）
- [ ] API 失败不会导致整个 fetcher 崩溃
- [ ] 数据库失败有明确的错误信息返回
- [ ] 地理封锁的 API 有代理回退
