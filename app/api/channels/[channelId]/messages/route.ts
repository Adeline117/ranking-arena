/**
 * Channel Messages API
 * POST: Send a message to a channel
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { channelId } = await params
    const { content, media_url, media_type, media_name } = await request.json()

    if (!content?.trim() && !media_url) {
      return NextResponse.json({ error: 'Message content required' }, { status: 400 })
    }

    if (content && content.length > 2000) {
      return NextResponse.json({ error: 'Message too long' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // Verify membership
    const { data: membership } = await supabase
      .from('channel_members')
      .select('role')
      .eq('channel_id', channelId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership) {
      return NextResponse.json({ error: 'Not a member' }, { status: 403 })
    }

    const msgData: Record<string, unknown> = {
      channel_id: channelId,
      sender_id: user.id,
      content: content?.trim() || '',
    }

    if (media_url) {
      msgData.media_url = media_url
      msgData.media_type = media_type || 'file'
      msgData.media_name = media_name
    }

    const { data: message, error } = await supabase
      .from('channel_messages')
      .insert(msgData)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: 'Failed to send' }, { status: 500 })
    }

    // Update read status for sender
    await supabase
      .from('channel_message_reads')
      .upsert({
        channel_id: channelId,
        user_id: user.id,
        last_read_at: new Date().toISOString(),
      })

    return NextResponse.json({ message })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
