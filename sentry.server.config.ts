/**
 * Sentry 服务端配置
 * 用于捕获 Node.js 运行时错误
 */

import * as Sentry from '@sentry/nextjs'

const SENTRY_DSN = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN

Sentry.init({
  dsn: SENTRY_DSN,
  
  // 启用性能监控
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  
  // 环境标识
  environment: process.env.NODE_ENV,
  
  // 禁用调试模式（避免潜在的渲染问题）
  debug: false,
  
  // 过滤已知的非关键错误
  ignoreErrors: [
    // 网络错误
    'ECONNRESET',
    'ENOTFOUND',
    'ETIMEDOUT',
    // Supabase 特定错误
    'JWTExpired',
    // 用户取消
    'AbortError',
  ],
  
  // 在发送前处理事件
  beforeSend(event, _hint) {
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
