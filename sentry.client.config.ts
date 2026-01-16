/**
 * Sentry 客户端配置
 * 用于捕获浏览器端错误
 */

import * as Sentry from '@sentry/nextjs'

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN

Sentry.init({
  dsn: SENTRY_DSN,
  
  // 启用性能监控
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  
  // 启用 Session Replay
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  
  // 环境标识
  environment: process.env.NODE_ENV,
  
  // 禁用调试模式（避免潜在的渲染问题）
  debug: false,
  
  // 过滤已知的非关键错误
  ignoreErrors: [
    // 浏览器扩展错误
    /^chrome-extension:\/\//,
    /^moz-extension:\/\//,
    // 网络错误
    'Network request failed',
    'Failed to fetch',
    'Load failed',
    // 用户取消操作
    'AbortError',
    // ResizeObserver 错误（通常无害）
    'ResizeObserver loop limit exceeded',
    'ResizeObserver loop completed with undelivered notifications',
  ],
  
  // 在发送前处理事件
  beforeSend(event, hint) {
    // 过滤开发环境的错误
    if (process.env.NODE_ENV === 'development') {
      console.log('[Sentry] Would send event:', event)
      // 开发环境仍然发送，但可以在这里阻止
    }
    
    // 脱敏处理
    if (event.user) {
      delete event.user.ip_address
    }
    
    return event
  },
  
  // 设置标签
  initialScope: {
    tags: {
      app: 'ranking-arena',
      platform: 'web',
    },
  },
  
  // 集成配置
  integrations: [
    Sentry.replayIntegration({
      // 隐藏敏感信息
      maskAllText: false,
      maskAllInputs: true,
      blockAllMedia: false,
    }),
    Sentry.browserTracingIntegration(),
  ],
})
