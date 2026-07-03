import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { parseLimit, parseOffset } from '@/lib/utils/safe-parse'

const logger = createLogger('api:user-activities')

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const { handle } = await params
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)
    const limit = parseLimit(searchParams.get('limit'), 20, 50)
    const offset = parseOffset(searchParams.get('offset'))

    // Resolve handle to user_id
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('handle', decodeURIComponent(handle))
      .maybeSingle()

    if (!profile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const { data: activities, error } = await supabase
      .from('user_activities')
      // user_activities 真列: activity_type/target_id/target_type/metadata(无 title/description/
      // link 列)——旧 select 400→整个活动页 500。type 别名到 activity_type,展示数据在 metadata。
      .select('id, user_id, type:activity_type, target_id, target_type, metadata, created_at')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch activities' }, { status: 500 })
    }

    return NextResponse.json({
      activities: activities || [],
      hasMore: (activities?.length || 0) === limit,
    })
  } catch (error) {
    logger.error('GET failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
