/**
 * Next.js Client Instrumentation
 * Sentry client-side configuration for browser error and performance monitoring
 *
 * This file replaces sentry.client.config.ts for Turbopack compatibility
 */

import * as Sentry from '@sentry/nextjs'

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN

Sentry.init({
  dsn: SENTRY_DSN,

  // Performance monitoring - 20% in production, 100% in development
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,

  // Session Replay
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  // Profiling
  profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 0,

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
      return process.env.NODE_ENV === 'production' ? 0.3 : 1.0
    }

    // Critical user action pages
    if (name?.includes('/trader/') || name?.includes('/post/')) {
      return process.env.NODE_ENV === 'production' ? 0.25 : 1.0
    }

    // Default sampling rate
    return process.env.NODE_ENV === 'production' ? 0.2 : 1.0
  },

  // Process events before sending
  beforeSend(event, _hint) {
    // Log events in development
    if (process.env.NODE_ENV === 'development') {
      console.log('[Sentry] Would send event:', event)
    }

    // Sanitize user data
    if (event.user) {
      delete event.user.ip_address
    }

    // Add custom context
    if (typeof window !== 'undefined') {
      event.contexts = {
        ...event.contexts,
        browser: {
          ...event.contexts?.browser,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
          },
        },
      }
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

  // Integrations
  integrations: [
    Sentry.replayIntegration({
      // Privacy settings
      maskAllText: false,
      maskAllInputs: true,
      blockAllMedia: false,
    }),
    Sentry.browserTracingIntegration({
      // Track page load
      enableLongTask: true,
      enableInp: true,
    }),
    Sentry.feedbackIntegration({
      // Feedback configuration
      colorScheme: 'dark',
      buttonLabel: 'Feedback',
      submitButtonLabel: 'Submit',
      cancelButtonLabel: 'Cancel',
      formTitle: 'Report an Issue',
      messagePlaceholder: 'Please describe the issue you encountered...',
      successMessageText: 'Thank you for your feedback!',
      showBranding: false,
      autoInject: false,
    }),
  ],
})

// Export for navigation instrumentation
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart

export { Sentry }
