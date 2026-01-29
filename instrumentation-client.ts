/**
 * Next.js Client Instrumentation
 * Sentry client-side configuration for browser error and performance monitoring
 *
 * This file replaces sentry.client.config.ts for Turbopack compatibility
 *
 * Performance optimization:
 * - Sentry.init() is deferred until the browser is idle (after LCP)
 *   to remove ~200KB from the critical JS path
 * - Replay and Feedback integrations are lazy-loaded even further
 */

import * as Sentry from '@sentry/nextjs'

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN

/**
 * Initialize Sentry with all configuration.
 * Called after the page is idle to avoid blocking FCP/LCP.
 */
function initSentry() {
  Sentry.init({
    dsn: SENTRY_DSN,

    // Performance monitoring - reduced for better performance
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

    // Session Replay - using lazy loading, set to 0 initially
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,

    // Profiling - disabled to reduce overhead
    profilesSampleRate: 0,

    // Environment
    environment: process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || 'development',

    // Disable debug mode
    debug: false,

    // Filter known non-critical errors
    ignoreErrors: [
      // Browser extension errors
      /^chrome-extension:\/\//,
      /^moz-extension:\/\//,
      // Network errors
      'Network request failed',
      'Failed to fetch',
      'Load failed',
      // User cancellation
      'AbortError',
      // ResizeObserver errors (usually harmless)
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      // Hydration errors (usually caused by browser extensions)
      'Hydration failed',
      'Text content does not match',
    ],

    // Filter unimportant transactions
    tracesSampler: (samplingContext) => {
      const name = samplingContext.name

      // Don't sample static resource requests
      if (name?.includes('/_next/static') || name?.includes('/favicon')) {
        return 0
      }

      // Higher sampling rate for API requests
      if (name?.includes('/api/')) {
        return process.env.NODE_ENV === 'production' ? 0.2 : 1.0
      }

      // Critical user action pages
      if (name?.includes('/trader/') || name?.includes('/post/')) {
        return process.env.NODE_ENV === 'production' ? 0.15 : 1.0
      }

      // Default sampling rate
      return process.env.NODE_ENV === 'production' ? 0.1 : 1.0
    },

    // Process events before sending
    beforeSend(event, _hint) {
      // Sanitize user data
      if (event.user) {
        delete event.user.ip_address
      }

      return event
    },

    // Process transactions before sending
    beforeSendTransaction(transaction) {
      // Filter out very short transactions (likely cancelled requests)
      const duration = transaction.timestamp && transaction.start_timestamp
        ? (transaction.timestamp - transaction.start_timestamp) * 1000
        : 0

      if (duration < 10) {
        return null
      }

      return transaction
    },

    // Set tags
    initialScope: {
      tags: {
        app: 'ranking-arena',
        platform: 'web',
      },
    },

    // Minimal integrations for initial load - others lazy-loaded after LCP
    integrations: [
      Sentry.browserTracingIntegration({
        enableLongTask: false, // Disable to reduce overhead
        enableInp: true,
      }),
    ],
  })

  // Lazy load Replay integration after Sentry is initialized + 5s
  if (process.env.NODE_ENV === 'production') {
    setTimeout(() => {
      const client = Sentry.getClient()
      if (client) {
        client.addIntegration(
          Sentry.replayIntegration({
            maskAllText: false,
            maskAllInputs: true,
            blockAllMedia: true, // Block media to reduce payload
          })
        )
      }
    }, 5000)
  }
}

/**
 * Defer Sentry initialization until the browser is idle.
 * Uses requestIdleCallback with a fallback to setTimeout(fn, 3000)
 * so Sentry's ~200KB JS evaluation does not block FCP/LCP.
 */
if (typeof window !== 'undefined') {
  const deferInit = () => {
    if ('requestIdleCallback' in window) {
      (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void })
        .requestIdleCallback(initSentry, { timeout: 4000 })
    } else {
      setTimeout(initSentry, 3000)
    }
  }

  if (document.readyState === 'complete') {
    deferInit()
  } else {
    window.addEventListener('load', deferInit, { once: true })
  }
}

// Export for navigation instrumentation
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart

export { Sentry }
