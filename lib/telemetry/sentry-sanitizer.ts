const FILTERED_VALUE = '[Filtered]'
const RECOVERY_TOKEN_KEY = 'recovery_token'
const URL_PARAMETER = /(^|[?&#])([^?=&#\s]+)(?:=[^&#\s]*)?/gu

function isRecoveryTokenKey(value: string): boolean {
  try {
    return decodeURIComponent(value.replace(/\+/gu, ' ')).toLowerCase() === RECOVERY_TOKEN_KEY
  } catch {
    return value.toLowerCase() === RECOVERY_TOKEN_KEY
  }
}

/**
 * Preserve the useful route/URL while replacing only the recovery credential.
 * This supports absolute URLs, relative transaction names, query strings and
 * fragment parameter lists without ever decoding or returning the token.
 */
export function redactRecoveryTokenFromUrl(value: string): string {
  return value.replace(URL_PARAMETER, (match, delimiter: string, key: string) =>
    isRecoveryTokenKey(key) ? `${delimiter}${key}=${FILTERED_VALUE}` : match
  )
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return redactRecoveryTokenFromUrl(value)
  if (value === null || typeof value !== 'object' || depth > 16) return value
  if (seen.has(value)) return value
  seen.add(value)

  if (Array.isArray(value)) {
    // Sentry request.query_string may use an array of [name, value] tuples.
    if (value.length >= 2 && typeof value[0] === 'string' && isRecoveryTokenKey(value[0])) {
      value[1] = FILTERED_VALUE
    }
    for (let index = 0; index < value.length; index += 1) {
      value[index] = sanitizeValue(value[index], seen, depth + 1)
    }
    return value
  }

  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    try {
      record[key] = isRecoveryTokenKey(key)
        ? FILTERED_VALUE
        : sanitizeValue(record[key], seen, depth + 1)
    } catch {
      // Sentry events are plain objects, but a defensive getter/setter failure
      // must not break application error reporting.
    }
  }
  return value
}

/**
 * Global last-mile scrubber for Sentry errors and transactions.
 *
 * Traversing the serializable event covers current SDK locations such as
 * request.url/query_string/headers, transaction names, breadcrumbs, span data
 * and source URLs while retaining all non-sensitive diagnostics.
 */
export function sanitizeSentryEvent<T>(event: T): T {
  return sanitizeValue(event, new WeakSet<object>(), 0) as T
}

/**
 * Defense-in-depth for Sentry Replay custom frames (navigation spans, network
 * breadcrumbs, etc.). rrweb Meta frames and Replay context URLs bypass this
 * callback, so the recovery flow also guarantees a clean URL at the source.
 */
export function sanitizeSentryReplayRecordingEvent<T>(event: T): T {
  return sanitizeSentryEvent(event)
}
