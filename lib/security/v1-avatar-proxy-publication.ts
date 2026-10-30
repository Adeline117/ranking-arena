/**
 * V1 avatar-proxy publication boundary.
 *
 * This module is deliberately browser-safe and uses a checked-in false value:
 * inherited runtime configuration must not reactivate remote avatar acquisition.
 * It controls only source built from this revision; it does not inspect or
 * change an already deployed route, cached response, or direct browser image.
 */

export const V1_AVATAR_PROXY_PUBLISHED = false as const

export const V1_AVATAR_PROXY_NOT_PUBLISHED_CODE = 'AVATAR_PROXY_NOT_PUBLISHED' as const

export const V1_AVATAR_PROXY_UNAVAILABLE_BODY = {
  error: 'Avatar proxy is temporarily unavailable during V1 verification.',
  code: V1_AVATAR_PROXY_NOT_PUBLISHED_CODE,
} as const

export const V1_AVATAR_PROXY_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

const V1_AVATAR_PROXY_PATHNAMES = new Set(['/api/avatar', '/api/v1/avatar'])

export function isV1AvatarProxyPublished(): boolean {
  return V1_AVATAR_PROXY_PUBLISHED
}

/**
 * Reject persisted legacy route values before a browser can render them as a
 * normal rooted asset. Query strings are intentionally ignored.
 */
export function isV1AvatarProxyPath(value: string): boolean {
  try {
    return V1_AVATAR_PROXY_PATHNAMES.has(new URL(value, 'https://avatar.invalid').pathname)
  } catch {
    return false
  }
}
