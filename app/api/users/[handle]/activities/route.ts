import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { parseLimit, parseOffset } from '@/lib/utils/safe-parse'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { readPublicProfileAudienceByHandle } from '@/lib/profile/public-audience'

const logger = createLogger('api:user-activities')

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
    if (rateLimitResponse) return rateLimitResponse

    const { handle } = await params
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)
    const limit = parseLimit(searchParams.get('limit'), 20, 50)
    const offset = parseOffset(searchParams.get('offset'))

    let decodedHandle: string
    try {
      decodedHandle = decodeURIComponent(handle)
    } catch {
      return NextResponse.json({ error: 'Invalid handle' }, { status: 400 })
    }

    // service_role bypasses RLS, so current public-account state is an explicit
    // resource authorization step rather than a profile-existence lookup.
    const audience = await readPublicProfileAudienceByHandle(supabase, decodedHandle)

    if (audience.status !== 'active') {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const { data: activities, error } = await supabase
      .from('user_activities')
      // user_activities 真列: activity_type/target_id/target_type/metadata(无 title/description/
      // link 列)——旧 select 400→整个活动页 500。type 别名到 activity_type,展示数据在 metadata。
      .select('id, user_id, type:activity_type, target_id, target_type, metadata, created_at')
      .eq('user_id', audience.profile.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch activities' }, { status: 500 })
    }

    return NextResponse.json(
      {
        activities: activities || [],
        hasMore: (activities?.length || 0) === limit,
      },
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } }
    )
  } catch (error) {
    logger.error('GET failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
