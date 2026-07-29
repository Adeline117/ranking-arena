/**
 * GET /api/recommendations/personal
 *
 * Authenticated endpoint returning personalized trader recommendations.
 * The engine caches by user and exact sealed publication proof identity.
 */

import { withAuth } from '@/lib/api/middleware'
import { getPersonalRecommendations } from '@/lib/recommendations/personal'
import { createLogger } from '@/lib/utils/logger'
import { parseLimit } from '@/lib/utils/safe-parse'

const _logger = createLogger('api-rec-personal')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const preferredRegion = ['sfo1', 'hnd1']

export const GET = withAuth(
  async ({ user, request }) => {
    const { searchParams } = new URL(request.url)
    const limit = parseLimit(searchParams.get('limit'), 20, 50)

    const recommendations = await getPersonalRecommendations(user.id, 50)

    const sliced = recommendations.slice(0, limit)

    return { data: sliced, meta: { count: sliced.length, userId: user.id } }
  },
  { name: 'get-recommendations-personal', rateLimit: 'authenticated' }
)
