/**
 * GET /api/hashtags/[tag]
 * Return posts for a specific hashtag, paginated.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  successWithPagination,
  handleError,
  checkRateLimit,
  RateLimitPresets,
  validateNumber,
  validateEnum,
  unauthorized,
  validationError,
} from '@/lib/api'
import {
  canonicalizeHashtag,
  getPostsByHashtag,
  HashtagViewerRejectedError,
} from '@/lib/data/hashtags'

const POSTGRES_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function protectHashtagResponse<T extends NextResponse>(response: T): T {
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

export async function GET(request: NextRequest, { params }: { params: Promise<{ tag: string }> }) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return protectHashtagResponse(rateLimitResponse)

  try {
    const { tag } = await params
    const { searchParams } = new URL(request.url)

    const authorization = request.headers.get('authorization')
    const user = authorization === null ? null : await getAuthUser(request)
    if (authorization !== null && (!user || !POSTGRES_UUID_RE.test(user.id))) {
      const response = unauthorized('Invalid or expired authentication credentials')
      response.headers.set('WWW-Authenticate', 'Bearer')
      return protectHashtagResponse(response)
    }

    let canonicalTag: string
    try {
      canonicalTag = canonicalizeHashtag(tag)
    } catch {
      return protectHashtagResponse(validationError('Invalid hashtag'))
    }

    const limit =
      validateNumber(searchParams.get('limit'), { min: 1, max: 100, integer: true }) ?? 20
    const offset =
      validateNumber(searchParams.get('offset'), { min: 0, max: 10_000, integer: true }) ?? 0
    const sort_by =
      validateEnum(searchParams.get('sort_by'), ['hot_score', 'created_at'] as const) ??
      'created_at'

    const supabase = getSupabaseAdmin()
    const page = await getPostsByHashtag(supabase, canonicalTag, {
      limit,
      offset,
      sort_by,
      viewer_id: user?.id ?? null,
    })

    // Post audience can change independently of the hashtag mapping. The data
    // layer re-authorizes every service-role row, and the final payload must
    // not outlive that decision in a browser or CDN cache.
    const response = successWithPagination(
      { posts: page.posts, tag: page.tag, total: page.total },
      { limit, offset, has_more: page.has_more, total: page.total }
    )
    return protectHashtagResponse(response)
  } catch (error: unknown) {
    if (error instanceof HashtagViewerRejectedError) {
      const response = unauthorized('Invalid or expired authentication credentials')
      response.headers.set('WWW-Authenticate', 'Bearer')
      return protectHashtagResponse(response)
    }
    return protectHashtagResponse(handleError(error, 'hashtags [tag] GET'))
  }
}
