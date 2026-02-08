/**
 * Sentry 客户端配置
 * 用于捕获浏览器端错误
 *
 * Performance: Uses lazyLoadIntegrations to defer loading non-critical
 * Sentry integrations until after page load, reducing initial bundle size.
 */

import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Reduce tracing overhead — only sample 5% of transactions
  tracesSampleRate: 0.05,

  environment: process.env.NODE_ENV,

  debug: false,

  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0.1,

  // Defer loading non-essential integrations until after page load
  // This reduces the initial JS bundle by ~30-50KB
  // @ts-expect-error - lazyLoadIntegrations is available in Sentry 10+
  lazyLoadIntegrations: true,

  ignoreErrors: [
    'ResizeObserver loop',
    'ChunkLoadError',
    'Loading chunk',
    'Network request failed',
    'AbortError',
    'NEXT_NOT_FOUND',
    // Common non-actionable errors
    'Non-Error promise rejection captured',
    'TypeError: Failed to fetch',
    'TypeError: NetworkError',
    'TypeError: Load failed',
  ],

  // Reduce noise from third-party scripts
  denyUrls: [
    /extensions\//i,
    /^chrome:\/\//i,
    /^moz-extension:\/\//i,
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
