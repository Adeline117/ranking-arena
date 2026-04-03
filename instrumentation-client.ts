/**
 * Next.js Client Instrumentation
 * Sentry 客户端动态加载 — 不阻塞 FCP/LCP
 *
 * 策略：
 * - 移除 withSentryConfig 后，Sentry 不再注入关键路径（省 ~700KB）
 * - 客户端 SDK 在 idle 时动态 import，仅加载错误捕获 + 基础 tracing
 * - Replay 在 Sentry init 后 5s 延迟加载
 */

/**
 * Initialize Sentry with all configuration.
 * Called after the page is idle to avoid blocking FCP/LCP.
 */
async function initSentry() {
  const Sentry = await import('@sentry/nextjs')

  const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN
  if (!SENTRY_DSN) return

  Sentry.init({
    dsn: SENTRY_DSN,

    // 性能监控 — 生产环境低采样率
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

    // Session Replay — 初始为 0，后续延迟加载
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,

    // Profiling — 关闭以减少开销
    profilesSampleRate: 0,

    // 环境
    environment: process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || 'development',

    debug: false,

    // 过滤已知非关键错误
    ignoreErrors: [
      /^chrome-extension:\/\//,
      /^moz-extension:\/\//,
      'Network request failed',
      'Network connection failed',
      'Failed to fetch',
      'Load failed',
      'AbortError',
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      'Hydration failed',
      'Text content does not match',
      // HTTP 4xx — not bugs, normal auth/permission flow
      /^HTTP 40[0-9]$/,
      'HTTP 401',
      'HTTP 403',
      'HTTP 404',
      // Supabase auth lock contention — benign, auto-recovers
      'Lock "lock:arena-auth"',
      'another request stole it',
      // Network timeouts — user-side, not actionable
      'Request timed out',
      'Request failed',
      'request timed out',
      // DOM manipulation errors — browser extensions or hydration mismatch
      "Failed to execute 'removeChild'",
      "Failed to execute 'insertBefore'",
      'is not a child of this node',
    ],

    // 按路由采样
    tracesSampler: (samplingContext) => {
      const name = samplingContext.name
      if (name?.includes('/_next/static') || name?.includes('/favicon')) return 0
      if (name?.includes('/api/')) return process.env.NODE_ENV === 'production' ? 0.2 : 1.0
      if (name?.includes('/trader/') || name?.includes('/post/')) return process.env.NODE_ENV === 'production' ? 0.15 : 1.0
      return process.env.NODE_ENV === 'production' ? 0.1 : 1.0
    },

    beforeSend(event, hint) {
      if (event.user) delete event.user.ip_address

      // Drop HTTP 4xx errors (auth expiry, not-found, etc.)
      const msg = (hint?.originalException as Error)?.message || event.message || ''
      if (/HTTP\s+4\d{2}/.test(msg)) return null

      // Drop headless browser / bot errors (Vercel preview, crawlers)
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
      if (/HeadlessChrome|Googlebot|bingbot|Bytespider/.test(ua)) return null

      // Drop DOM NotFoundError (browser extensions, hydration race)
      if (msg.includes('not a child of this node') || msg.includes('removeChild') || msg.includes('insertBefore')) return null

      return event
    },

    beforeSendTransaction(transaction) {
      const duration = transaction.timestamp && transaction.start_timestamp
        ? (transaction.timestamp - transaction.start_timestamp) * 1000
        : 0
      return duration < 10 ? null : transaction
    },

    initialScope: {
      tags: { app: 'ranking-arena', platform: 'web' },
    },

    integrations: [
      Sentry.browserTracingIntegration({
        enableLongTask: false,
        enableInp: true,
      }),
    ],
  })

  // 延迟加载 Replay（+5s）
  if (process.env.NODE_ENV === 'production') {
    setTimeout(() => {
      const client = Sentry.getClient()
      if (client) {
        client.addIntegration(
          Sentry.replayIntegration({
            maskAllText: false,
            maskAllInputs: true,
            blockAllMedia: true,
          })
        )
      }
    }, 5000)
  }
}

/**
 * 延迟初始化：idle 时加载，不阻塞渲染
 */
if (typeof window !== 'undefined') {
  const deferInit = () => {
    if ('requestIdleCallback' in window) {
      (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void })
        .requestIdleCallback(() => { initSentry() }, { timeout: 4000 })
    } else {
      setTimeout(() => { initSentry() }, 3000)
    }
  }

  if (document.readyState === 'complete') {
    deferInit()
  } else {
    window.addEventListener('load', deferInit, { once: true })
  }
}

// 导航 instrumentation — 延迟获取
export const onRouterTransitionStart = (...args: unknown[]) => {
  import('@sentry/nextjs').then(Sentry => {
    Sentry.captureRouterTransitionStart(...(args as Parameters<typeof Sentry.captureRouterTransitionStart>))
  }).catch(() => {}) // eslint-disable-line no-restricted-syntax -- fire-and-forget, failure is non-critical
}
