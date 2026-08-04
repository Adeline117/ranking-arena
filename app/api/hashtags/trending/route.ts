/**
 * GET /api/hashtags/trending
 * Return the top 20 hashtags by current anonymous-readable post count.
 */

export const runtime = 'nodejs'
export const maxDuration = 10
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
  unauthorized,
} from '@/lib/api'
import { getTrendingHashtags } from '@/lib/data/hashtags'

const POSTGRES_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function protectTrendingResponse<T extends NextResponse>(response: T): T {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  response.headers.set('CDN-Cache-Control', 'no-store')
  response.headers.set('Vercel-CDN-Cache-Control', 'no-store')
  const varyFields = (response.headers.get('Vary') ?? '')
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean)
  if (!varyFields.some((field) => field.toLowerCase() === 'authorization')) {
    varyFields.push('Authorization')
  }
  response.headers.set('Vary', varyFields.join(', '))
  return response
}

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return protectTrendingResponse(rateLimitResponse)

  try {
    // Trending is intentionally an anonymous audience, but a supplied invalid
    // bearer must not be silently treated as if no credential was sent.
    const authorization = request.headers.get('authorization')
    const authenticatedUser = authorization === null ? null : await getAuthUser(request)
    if (
      authorization !== null &&
      (!authenticatedUser || !POSTGRES_UUID_RE.test(authenticatedUser.id))
    ) {
      const response = unauthorized('Invalid or expired authentication credentials')
      response.headers.set('WWW-Authenticate', 'Bearer')
      return protectTrendingResponse(response)
    }

    const supabase = getSupabaseAdmin()
    const hashtags = await getTrendingHashtags(supabase, 20)
    return protectTrendingResponse(success({ hashtags }))
  } catch (error: unknown) {
    return protectTrendingResponse(handleError(error, 'hashtags trending GET'))
  }
}
