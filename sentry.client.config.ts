/**
 * Sentry 客户端配置
 * 用于捕获浏览器端错误
 */

import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  tracesSampleRate: 0.1,

  environment: process.env.NODE_ENV,

  debug: false,

  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0.1,

  ignoreErrors: [
    'ResizeObserver loop',
    'ChunkLoadError',
    'Loading chunk',
    'Network request failed',
    'AbortError',
    'NEXT_NOT_FOUND',
  ],

  beforeSend(event) {
    if (event.user) {
      delete event.user.ip_address
    }
    return event
  },

  initialScope: {
    tags: {
      app: 'ranking-arena',
      platform: 'client',
    },
  },
})
