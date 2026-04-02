/**
 * GET /api/recommendations/personal
 *
 * Authenticated endpoint returning personalized trader recommendations.
 * Results cached per user in Upstash Redis with 5-minute TTL.
 */

import { withAuth } from '@/lib/api/middleware'
import { getPersonalRecommendations } from '@/lib/recommendations/personal'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import { createLogger } from '@/lib/utils/logger'
import type { PersonalRecommendation } from '@/lib/recommendations/personal'

const _logger = createLogger('api-rec-personal')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const preferredRegion = ['sfo1', 'hnd1']

export const GET = withAuth(async ({ user, request }) => {
  const { searchParams } = new URL(request.url)
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)))

  const cacheKey = `recommendations:personal:${user.id}`

  const recommendations = await tieredGetOrSet<PersonalRecommendation[]>(
    cacheKey,
    () => getPersonalRecommendations(user.id, 50),
    'hot',
    ['recommendations', `user:${user.id}`],
  )

  const sliced = recommendations.slice(0, limit)

  return { data: sliced, meta: { count: sliced.length, userId: user.id } }
}, { name: 'get-recommendations-personal', rateLimit: 'authenticated' })
