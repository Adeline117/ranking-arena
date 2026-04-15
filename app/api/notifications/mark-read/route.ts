/**
 * 标记通知已读 API
 *
 * POST /api/notifications/mark-read
 * Body: { notification_ids?: string[], mark_all?: boolean }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { extractUserFromRequest } from '@/lib/auth/extract-user'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { withApiHandler } from '@/lib/api/with-handler'

export const dynamic = 'force-dynamic'

export const POST = withApiHandler('notifications/mark-read', async (request: NextRequest) => {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  const { user, error: authError } = await extractUserFromRequest(request)
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  const body = await request.json()
  const { notification_ids, mark_all } = body

  if (mark_all) {
    const { error } = await supabase
      .from('notifications')
      .update({ read: true, read_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('read', false)

    if (error) {
      throw error
    }

    return NextResponse.json({
      success: true,
      message: 'All marked as read',
    })
  }

  if (!notification_ids || notification_ids.length === 0) {
    return NextResponse.json({ error: 'Missing notification ID' }, { status: 400 })
  }

  const { error } = await supabase
    .from('notifications')
    .update({ read: true, read_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .in('id', notification_ids)

  if (error) {
    throw error
  }

  return NextResponse.json({
    success: true,
    message: `${notification_ids.length} notifications marked as read`,
  })
})
