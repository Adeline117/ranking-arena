import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { parseLimit } from '@/lib/utils/safe-parse'
import { escapeLikePattern } from '@/lib/sanitize'
import { isPublicProfileActive } from '@/lib/profile/public-audience'

const logger = createLogger('api:users-search')

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.search)
    if (rateLimitResponse) return rateLimitResponse

    const user = await getAuthUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const q = request.nextUrl.searchParams.get('q')?.trim()
    const limit = parseLimit(request.nextUrl.searchParams.get('limit'), 10, 20)

    if (!q) {
      return NextResponse.json(
        { users: [] },
        { headers: { 'Cache-Control': 'private, no-store, max-age=0' } }
      )
    }

    const supabase = getSupabaseAdmin()

    const escapedQ = escapeLikePattern(q)

    const candidateLimit = Math.min(limit * 4, 80)
    const { data: userCandidates, error: userCandidatesError } = await supabase
      .from('user_profiles')
      .select('id, handle, avatar_url, deleted_at, banned_at, is_banned, ban_expires_at')
      .ilike('handle', `%${escapedQ}%`)
      .neq('id', user.id)
      .is('deleted_at', null)
      .is('banned_at', null)
      .limit(candidateLimit)

    if (userCandidatesError) {
      logger.error('profile audience query failed', { error: userCandidatesError.message })
      return NextResponse.json({ error: 'Server error' }, { status: 500 })
    }

    const now = Date.now()
    const users = (userCandidates || [])
      .filter((candidate) => isPublicProfileActive(candidate, now))
      .slice(0, limit)
      .map(({ id, handle, avatar_url }) => ({ id, handle, avatar_url }))

    return NextResponse.json(
      { users },
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } }
    )
  } catch (error) {
    logger.error('GET failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
