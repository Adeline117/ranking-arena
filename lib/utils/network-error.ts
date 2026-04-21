/**
 * Shared network error handler.
 *
 * Detects offline state, differentiates timeout vs generic network errors,
 * and provides user-friendly i18n messages. All components and hooks should
 * use these helpers instead of hand-rolling catch-block logic.
 */

/**
 * Returns true if the error looks like a network / fetch failure.
 * Covers TypeError from failed fetch, AbortError from timeouts, and
 * DOMException variants across browser engines.
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError && error.message.includes('fetch')) return true
  if (error instanceof DOMException && error.name === 'AbortError') return true
  // Chrome sometimes throws a generic DOMException for network failures
  if (error instanceof DOMException && error.name === 'NetworkError') return true
  return false
}

/**
 * Returns true if the browser reports being offline.
 * Safe for SSR (returns false on the server).
 */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && !navigator.onLine
}

/**
 * Pick the best user-facing error message for a network error.
 *
 * Priority:
 * 1. Offline  -> "You are offline. Please check your connection."
 * 2. Timeout  -> "Request timed out. Please try again."
 * 3. Network  -> "Network error. Please try again."
 * 4. Fallback -> "Something went wrong."
 */
export function getNetworkErrorMessage(
  error: unknown,
  t: (key: string) => string,
): string {
  if (isOffline()) {
    return t('offlineError')
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return t('requestTimeout')
  }
  if (isNetworkError(error)) {
    return t('networkError')
  }
  return t('unknownError')
}

/**
 * Returns true if the error is transient and the operation could succeed
 * on retry (offline, timeout, or generic network failure).
 */
export function isRetryableError(error: unknown): boolean {
  return isNetworkError(error) || isOffline()
}
