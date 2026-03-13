/**
 * ETag support for API responses
 * Enables conditional requests (If-None-Match) to reduce bandwidth
 */

import { NextRequest, NextResponse } from 'next/server'

/**
 * Generate an ETag string from arbitrary data.
 * Uses a fast hash via Web Crypto API (Edge-compatible).
 */
export function generateETag(data: unknown): string {
  // Simple FNV-1a hash for ETag — fast, no Node.js crypto dependency
  const str = JSON.stringify(data)
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = (hash * 16777619) >>> 0
  }
  return `"${hash.toString(16)}"`
}

/**
 * Check if the client's If-None-Match header matches the given ETag.
 * Returns true if the client already has the current version.
 */
export function isETagMatch(request: NextRequest, etag: string): boolean {
  const ifNoneMatch = request.headers.get('if-none-match')
  if (!ifNoneMatch) return false

  // Handle multiple ETags separated by commas
  const clientTags = ifNoneMatch.split(',').map(t => t.trim())
  return clientTags.includes(etag) || clientTags.includes('*')
}

/**
 * Add ETag header to a response.
 * If the request's If-None-Match matches, returns a 304 Not Modified instead.
 *
 * @param request - The incoming request (to check If-None-Match)
 * @param response - The prepared response
 * @param data - The response data used to compute the ETag
 * @returns Either the original response with ETag header, or a 304 response
 */
export function withETag(
  request: NextRequest,
  response: NextResponse,
  data: unknown
): NextResponse {
  const etag = generateETag(data)

  if (isETagMatch(request, etag)) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: etag,
        'Cache-Control': response.headers.get('Cache-Control') || '',
      },
    })
  }

  response.headers.set('ETag', etag)
  return response
}
