/**
 * Sentry Edge 配置
 * 用于捕获 Edge Runtime（Middleware）错误
 */

import * as Sentry from '@sentry/nextjs'

const SENTRY_DSN = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN

Sentry.init({
  dsn: SENTRY_DSN,
  
  // 启用性能监控（Edge 环境采样率更低）
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.05 : 0.5,
  
  // 环境标识
  environment: process.env.NODE_ENV,
  
  // 禁用调试模式（避免潜在的渲染问题）
  debug: false,
  
  // 过滤错误
  ignoreErrors: [
    'ECONNRESET',
    'AbortError',
  ],
  
  // 在发送前处理事件
  beforeSend(event) {
    // 脱敏处理
    if (event.user) {
      delete event.user.ip_address
    }
    
    if (event.request?.headers) {
      delete event.request.headers['authorization']
      delete event.request.headers['cookie']
    }
    
    return event
  },
  
  // 设置标签
  initialScope: {
    tags: {
      app: 'ranking-arena',
      platform: 'edge',
    },
  },
})
