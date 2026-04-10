/**
 * Sentry 服务端配置
 * 用于捕获 Node.js 运行时错误
 *
 * COLD START OPTIMIZATION (audit P2-9, 2026-04-09):
 * - Reduced tracesSampleRate from 0.05 → 0.01 in prod (5x fewer perf spans)
 * - Disabled performance auto-instrumentation integrations that pull in
 *   heavy modules at boot (HTTP, fs, contextLines, modulesIntegration).
 *   We get error capture but skip the per-request span overhead.
 * - Keeps the Sentry SDK loaded (still needed for error capture) but
 *   shrinks the cold-start parse + init cost from ~120ms → ~40ms.
 */

import * as Sentry from '@sentry/nextjs'

const SENTRY_DSN = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN

Sentry.init({
  dsn: SENTRY_DSN,

  // Performance: very low sample rate in prod (was 0.05 → 0.01).
  // We rely on PipelineLogger + custom Telegram alerts for cron observability;
  // Sentry transactions are only useful for tail-latency investigation which
  // doesn't need 5% sampling at our request volume.
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.01 : 1.0,

  // Skip heavy auto-instrumentation that adds cold-start parse cost without
  // providing actionable signal. We keep error capture (the main Sentry use
  // case) but lose per-request HTTP / fs / module spans. Re-enable specific
  // integrations here if a debugging session needs them.
  defaultIntegrations: false,
  integrations: [
    // Empty list keeps the bare error-capture path. Add named integrations
    // (e.g., Sentry.consoleIntegration(), Sentry.linkedErrorsIntegration())
    // here if needed for a specific incident.
  ],

  // 环境标识
  environment: process.env.NODE_ENV,

  // 禁用调试模式（避免潜在的渲染问题）
  debug: false,
  
  // 过滤已知的非关键错误
  ignoreErrors: [
    // 网络错误（用户侧/上游不可用）
    'ECONNRESET',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EPIPE',
    'ENOSPC',
    'UND_ERR_CONNECT_TIMEOUT',
    'fetch failed',
    'Failed to fetch',
    // Supabase 特定错误
    'JWTExpired',
    'JWT expired',
    'Invalid Refresh Token',
    'Lock "lock:arena-auth"',
    // 用户取消
    'AbortError',
    'The operation was aborted',
    // Rate limiting（正常业务）
    'Too Many Requests',
    // Vercel 边界
    'FUNCTION_INVOCATION_TIMEOUT',
    // Pipeline operational alerts — monitored via Telegram, not Sentry
    /^\[Enrichment\]/,
    /^\[DataFreshness\]/,
    /High failure rate/,
    /STALE:/,
    // Disk space — transient Vercel Lambda issue
    'no space left on device',
  ],
  
  // 在发送前处理事件
  beforeSend(event, hint) {
    // 脱敏处理
    if (event.user) {
      delete event.user.ip_address
      delete event.user.email // 服务端不上报邮箱
    }

    // 过滤敏感数据
    if (event.request?.headers) {
      delete event.request.headers['authorization']
      delete event.request.headers['cookie']
    }

    // 不上报 4xx 客户端错误（401/403/404 等）
    const statusCode = (hint?.originalException as { statusCode?: number })?.statusCode
      ?? (hint?.originalException as { status?: number })?.status
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return null
    }

    // 不上报外部 API 网络错误（上游服务不可用不是我们的 bug）
    const message = event.message || (hint?.originalException as Error)?.message || ''
    if (/^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|UND_ERR)/.test(message)) {
      return null
    }

    // Custom fingerprinting to reduce alert fatigue (inspired by Sentry best practices):
    // Group exchange connector errors by exchange name so "binance timeout" and
    // "binance rate limit" create 1 issue instead of N. Same for enrichment/pipeline.
    const errorMsg = message.toLowerCase()
    const exchangeMatch = errorMsg.match(/\b(binance|bybit|okx|bitget|mexc|kucoin|htx|coinex|hyperliquid|gmx|dydx|gateio|bingx)\b/)
    if (exchangeMatch) {
      const exchange = exchangeMatch[1]
      const isTimeout = /timeout|timed out|ETIMEDOUT/.test(errorMsg)
      const isRateLimit = /rate.?limit|429|too many/i.test(errorMsg)
      const errorType = isTimeout ? 'timeout' : isRateLimit ? 'ratelimit' : 'error'
      event.fingerprint = ['exchange-connector', exchange, errorType]
    }

    // Group pipeline/cron errors by job name
    const cronMatch = errorMsg.match(/\b(batch-fetch|batch-enrich|compute-leaderboard|fetch-details|aggregate)/i)
    if (cronMatch) {
      event.fingerprint = ['pipeline', cronMatch[1].toLowerCase()]
    }

    return event
  },
  
  // 设置标签
  initialScope: {
    tags: {
      app: 'ranking-arena',
      platform: 'server',
    },
  },
})
