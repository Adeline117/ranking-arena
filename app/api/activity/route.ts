import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import logger from '@/lib/logger'

const VALID_ACTIONS = new Set([
  'page_view', 'search', 'follow', 'unfollow',
  'like', 'post', 'compare', 'library_view', 'trade_copy',
])

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    }

    const body = await request.json()
    const events: Array<{ action: string; metadata?: Record<string, unknown>; created_at?: string }> =
      body?.events

    if (!Array.isArray(events) || events.length === 0) {
      return NextResponse.json({ error: 'Invalid event data' }, { status: 400 })
    }

    if (events.length > 100) {
      return NextResponse.json({ error: 'Maximum 100 events per request' }, { status: 400 })
    }

    // 验证并构建插入行
    const rows = events
      .filter((e) => e.action && VALID_ACTIONS.has(e.action))
      .map((e) => ({
        user_id: user.id,
        action: e.action,
        metadata: e.metadata || {},
        created_at: e.created_at || new Date().toISOString(),
      }))

    if (rows.length === 0) {
      return NextResponse.json({ error: 'No valid events' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()
    const { error } = await supabase.from('user_activity').insert(rows)

    if (error) {
      logger.error('[activity] 插入Failed:', error)
      return NextResponse.json({ error: 'Save failed' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, count: rows.length })
  } catch (err) {
    logger.error('[activity] 请求异常:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
