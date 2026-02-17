import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, getAuthUser } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> }
) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { messageId } = await params
    const supabase = getSupabaseAdmin()

    // Verify ownership
    const { data: msg } = await supabase
      .from('direct_messages')
      .select('id, sender_id')
      .eq('id', messageId)
      .maybeSingle()

    if (!msg) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    if (msg.sender_id !== user.id) {
      return NextResponse.json({ error: 'Cannot delete others messages' }, { status: 403 })
    }

    // Soft delete
    const { error } = await supabase
      .from('direct_messages')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', messageId)

    if (error) {
      logger.error('Delete message error:', error)
      return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    logger.error('Delete message API error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
