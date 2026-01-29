/**
 * Next.js Client Instrumentation
 * Sentry client-side configuration for browser error and performance monitoring
 *
 * This file replaces sentry.client.config.ts for Turbopack compatibility
 *
 * Performance optimization: Replay and Feedback integrations are lazy-loaded
 * to reduce initial JavaScript bundle size (~200KB savings)
 */

import * as Sentry from '@sentry/nextjs'

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN

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

// Lazy load Replay integration after page is interactive
if (typeof window !== 'undefined') {
  // Wait for page to be fully loaded and interactive
  const loadReplayIntegration = () => {
    // Only load in production and after 5 seconds
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

  if (document.readyState === 'complete') {
    loadReplayIntegration()
  } else {
    window.addEventListener('load', loadReplayIntegration, { once: true })
  }
}

// Export for navigation instrumentation
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart

export { Sentry }
