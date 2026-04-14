import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'

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
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '10', 10) || 10, 20)

    if (!q) return NextResponse.json({ users: [] })

    const supabase = getSupabaseAdmin()

    const { data: users } = await supabase
      .from('user_profiles')
      .select('id, handle, avatar_url')
      .ilike('handle', `%${q}%`)
      .neq('id', user.id)
      .is('deleted_at', null)
      .limit(limit)

    return NextResponse.json({ users: users || [] })
  } catch (error) {
    logger.error('GET failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
