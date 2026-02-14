/**
 * GET /api/recommendations/personal
 *
 * Authenticated endpoint returning personalized trader recommendations.
 * Results cached per user in Upstash Redis with 5-minute TTL.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getPersonalRecommendations } from '@/lib/recommendations/personal'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import { createLogger } from '@/lib/utils/logger'
import type { PersonalRecommendation } from '@/lib/recommendations/personal'

const logger = createLogger('api-rec-personal')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function GET(req: NextRequest) {
  try {
    // Auth check
    const authHeader = req.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 },
      )
    }

    const token = authHeader.slice(7)
    const supabase = getSupabaseAdmin()
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 },
      )
    }

    const { searchParams } = new URL(req.url)
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)))

    const cacheKey = `recommendations:personal:${user.id}`

    const recommendations = await tieredGetOrSet<PersonalRecommendation[]>(
      cacheKey,
      () => getPersonalRecommendations(user.id, 50),
      'hot',
      ['recommendations', `user:${user.id}`],
    )

    const sliced = recommendations.slice(0, limit)

    return NextResponse.json({
      success: true,
      data: sliced,
      meta: { count: sliced.length, userId: user.id },
    })
  } catch (error) {
    logger.error('GET /api/recommendations/personal failed', { error })
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    )
  }
}
