/**
 * 全局错误拦截器 (simplified)
 * 
 * Only intercepts unhandled errors for Sentry reporting.
 * Does NOT modify fetch behavior — API error handling stays in each component.
 * Does NOT replace error messages — Sentry gets original errors.
 */

// Global Toast function reference (kept for backward compat)
type ToastFn = ((message: string, type?: 'success' | 'error' | 'warning' | 'info') => void) | null

export function setGlobalErrorHandler(_toastFn: ToastFn) {
  // No-op — toast handling moved to individual components
}

// Removed: interceptFetch — was replacing all fetch error messages with friendly text,
// making Sentry reports useless. Each component handles its own fetch errors.

/**
 * Intercept unhandled promise rejections — report to Sentry but don't hide from console
 */
export function interceptUnhandledPromises() {
  window.addEventListener('unhandledrejection', (event) => {
    const error = event.reason

    // Skip network errors and aborts — these are user-side issues
    if (error instanceof TypeError && error.message === 'Failed to fetch') return
    if (error?.name === 'AbortError') return

    // Report to Sentry with original error (not friendly message)
    if (typeof window !== 'undefined') {
       
      import('@sentry/nextjs').then((Sentry) => {
        Sentry.captureException(error, {
          tags: { source: 'unhandledPromise' },
        })
      }).catch(() => {})
    }

    // Do NOT preventDefault — let errors show in console for debugging
  })
}

/**
 * Intercept runtime errors — report to Sentry
 */
export function interceptGlobalErrors() {
  window.addEventListener('error', (event) => {
    const error = event.error
    if (!error) return

    // Skip browser extension errors
    if (event.filename?.includes('extension')) return
    // Skip Script error (cross-origin)
    if (event.message === 'Script error.') return

    if (typeof window !== 'undefined') {
       
      import('@sentry/nextjs').then((Sentry) => {
        Sentry.captureException(error, {
          tags: { source: 'globalError' },
          contexts: {
            errorLocation: {
              filename: event.filename,
              lineno: event.lineno,
              colno: event.colno,
            }
          }
        })
      }).catch(() => {})
    }
  })
}

/**
 * Initialize error interceptors
 */
export function initializeErrorInterceptors(toastFn?: ToastFn) {
  if (toastFn) {
    setGlobalErrorHandler(toastFn)
  }

  if (typeof window !== 'undefined') {
    // Removed: interceptFetch — components handle their own fetch errors
    interceptUnhandledPromises()
    interceptGlobalErrors()
    // Removed: interceptAxios — not used
  }
}

export function cleanupErrorInterceptors() {
  // No-op — kept for backward compat
}

// Keep exports for backward compat
export function interceptFetch() { /* removed — no-op */ }
export function interceptAxios() { /* removed — no-op */ }

const errorInterceptor = {
  setGlobalErrorHandler,
  interceptFetch,
  interceptUnhandledPromises,
  interceptGlobalErrors,
  interceptAxios,
  initializeErrorInterceptors,
  cleanupErrorInterceptors,
}
export default errorInterceptor
