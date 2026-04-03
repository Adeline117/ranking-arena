/**
 * Sentry 服务端配置
 * 用于捕获 Node.js 运行时错误
 */

import * as Sentry from '@sentry/nextjs'

const SENTRY_DSN = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN

Sentry.init({
  dsn: SENTRY_DSN,
  
  // 启用性能监控
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.05 : 1.0,
  
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
