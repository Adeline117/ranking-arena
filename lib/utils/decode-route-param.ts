/**
 * Decode a dynamic route segment without ever throwing.
 *
 * Next already decodes params during route matching, so a value like
 * "100%Win" reaches the handler as-is and a second decodeURIComponent throws
 * URIError (surfacing as a 500). Fall back to the raw value instead.
 */
export function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
